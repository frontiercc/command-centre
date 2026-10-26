// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Developer Pulse aggregator — deterministic, no classifier.
 *
 * Two stages, run on the hourly scheduler cycle:
 *   1. rollupCodeSessionStats() — recompute per-session rollups for sessions
 *      with new activity since the last run (high-water mark on ingested_at).
 *   2. runCodeHourlyAggregation() — write code_metrics snapshots per scope
 *      (user / team / function / organisation) over a 7-day window.
 *
 * Follows the pattern in lib/db/error-queries.ts / lib/db/queries.ts and
 * mirrors lib/pulse/aggregator.ts's writeMetric for the
 * code_metrics rolling/week write semantics: 'rolling' rows are a plain
 * insert (the partial unique index `idx_code_metrics_week` — WHERE
 * granularity='week' — can never match a rolling row, so it always appends);
 * 'week' rows are upserted via onConflictDoUpdate with
 * `targetWhere: sql\`granularity = 'week'\`` as the partial index arbiter.
 */
import { and, desc, eq, gte, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue, setConfigValue } from '@/lib/config';
import { getCodeModelRates, priceTokens, type ModelRates } from '@/lib/pulse/code/rates';
import { runCodePulseAlerts } from '@/lib/alerts/code-pulse-alerts';
import { weekStart } from '@/lib/pulse/period';
import { activeSecondsFromTimestamps } from '@/lib/pulse/session-active-time';

const SEVEN_DAYS = 7 * 24 * 60 * 60;
export const ORG_SCOPE_ID = 'org';

type TypedClient = Awaited<ReturnType<typeof getTypedClient>>;

// ─── Phase 3 raw-execution facade (mirrors lib/db/queries.ts's rawAll) ────────
// Reserved for the one query below (the "dirty sessions" UNION) that's
// clearer as raw SQL than built via the query builder — Drizzle has no
// portable UNION-of-two-different-shaped-selects combinator in use elsewhere
// in this codebase.
interface RawFacade {
  execute: (q: unknown) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}
async function rawAll<T>(client: unknown, query: unknown): Promise<T[]> {
  const c = client as RawFacade;
  const res = await c.execute(query);
  return res.rows as T[];
}

// ─── Repo derivation ─────────────────────────────────────────────────────────

/**
 * Normalise a working directory to a repo identity.
 * "C:\Users\alex\code\my-app" → "my-app"; "/home/alex/work/api" → "api".
 * Desktop-container paths "/sessions/<name>" use the session name.
 */
export function deriveRepo(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const normalised = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalised) return null;
  const segments = normalised.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  return segments[segments.length - 1];
}

// ─── Stage 1: per-session rollup ─────────────────────────────────────────────

export async function rollupCodeSessionStats(): Promise<number> {
  const client = await getTypedClient();

  const lastRunIso = await getConfigValue('codeAggregatorLastRun');
  const since = lastRunIso ? Math.floor(new Date(lastRunIso).getTime() / 1000) : 0;

  // Sessions with new assistant metadata or new code user messages. A UNION
  // of two differently-shaped tables — kept as raw SQL (Rule 2).
  const dirty = await rawAll<{ session_id: string }>(client, sql`
     SELECT session_id FROM code_assistant_meta WHERE ingested_at >= ${since}
     UNION
     SELECT session_id FROM cowork_messages
     WHERE surface = 'code' AND message_type = 'code_user_message' AND ingested_at >= ${since}
  `);

  const cam = schema.codeAssistantMeta;
  const cm = schema.coworkMessages;
  const csi = schema.coworkSkillInvocations;
  const cmi = schema.coworkMcpInvocations;
  const css = schema.codeSessionStats;

  const now = Math.floor(Date.now() / 1000);
  let updated = 0;

  for (const { session_id } of dirty) {
    // Assistant-side aggregates (full recompute per session — idempotent).
    // SUM/MIN/MAX/COUNT are STRINGS on Postgres (bigint) — Number()-coerce at
    // the read site (Policy B); these feed spend/output figures downstream.
    const metaRows = await client
      .select({
        turns: sql<number | string | null>`SUM(CASE WHEN ${cam.model} != '' THEN 1 ELSE 0 END)`,
        tools: sql<number | string | null>`SUM(${cam.tool_use_count})`,
        errors: sql<number | string | null>`SUM(${cam.error_count})`,
        commits: sql<number | string | null>`SUM(${cam.commit_count})`,
        inp: sql<number | string | null>`SUM(${cam.input_tokens})`,
        outp: sql<number | string | null>`SUM(${cam.output_tokens})`,
        cw: sql<number | string | null>`SUM(${cam.cache_creation_tokens})`,
        cr: sql<number | string | null>`SUM(${cam.cache_read_tokens})`,
        first_at: sql<number | string | null>`MIN(${cam.occurred_at})`,
        last_at: sql<number | string | null>`MAX(${cam.occurred_at})`,
      })
      .from(cam)
      .where(eq(cam.session_id, session_id));
    const meta = metaRows[0];
    const turns = Number(meta?.turns ?? 0);
    const tools = Number(meta?.tools ?? 0);
    const errorsCount = Number(meta?.errors ?? 0);
    const commits = Number(meta?.commits ?? 0);
    const inp = Number(meta?.inp ?? 0);
    const outp = Number(meta?.outp ?? 0);
    const cw = Number(meta?.cw ?? 0);
    const cr = Number(meta?.cr ?? 0);
    const metaFirstAt = meta?.first_at != null ? Number(meta.first_at) : null;
    const metaLastAt = meta?.last_at != null ? Number(meta.last_at) : null;

    const lastCtxRows = await client
      .select({ user_id: cam.user_id, cwd: cam.cwd, git_branch: cam.git_branch })
      .from(cam)
      .where(and(eq(cam.session_id, session_id), ne(cam.cwd, '')))
      .orderBy(desc(cam.occurred_at))
      .limit(1);
    const lastCtx = lastCtxRows[0];

    const perModelRows = await client
      .select({
        model: cam.model,
        inp: sql<number | string | null>`SUM(${cam.input_tokens})`,
        outp: sql<number | string | null>`SUM(${cam.output_tokens})`,
        cw: sql<number | string | null>`SUM(${cam.cache_creation_tokens})`,
        cr: sql<number | string | null>`SUM(${cam.cache_read_tokens})`,
      })
      .from(cam)
      .where(and(eq(cam.session_id, session_id), ne(cam.model, '')))
      .groupBy(cam.model);

    const modelsJson: Record<string, { input: number; output: number; cache_creation: number; cache_read: number }> = {};
    for (const m of perModelRows) {
      if (!m.model) continue; // ne(cam.model, '') already excludes null/empty; guard for TS
      modelsJson[m.model] = {
        input: Number(m.inp ?? 0),
        output: Number(m.outp ?? 0),
        cache_creation: Number(m.cw ?? 0),
        cache_read: Number(m.cr ?? 0),
      };
    }

    // User-side aggregates
    const userSideRows = await client
      .select({
        msgs: sql<number | string>`COUNT(*)`,
        first_at: sql<number | string | null>`MIN(${cm.occurred_at})`,
        last_at: sql<number | string | null>`MAX(${cm.occurred_at})`,
        user_id: sql<string | null>`MAX(${cm.user_id})`,
      })
      .from(cm)
      .where(and(eq(cm.session_id, session_id), eq(cm.surface, 'code'), eq(cm.message_type, 'code_user_message')));
    const userSide = userSideRows[0];
    const userMsgs = Number(userSide?.msgs ?? 0);
    const userFirstAt = userSide?.first_at != null ? Number(userSide.first_at) : null;
    const userLastAt = userSide?.last_at != null ? Number(userSide.last_at) : null;
    const userSideUserId = userSide?.user_id ?? null;

    const skillRows = await client
      .select({ skill_name: csi.skill_name, invocation_type: csi.invocation_type })
      .from(csi)
      .where(eq(csi.session_id, session_id));

    const mcpRows = await client
      .selectDistinct({ mcp_server: cmi.mcp_server })
      .from(cmi)
      .where(eq(cmi.session_id, session_id));

    const firstAt = Math.min(metaFirstAt ?? Infinity, userFirstAt ?? Infinity);
    const lastAt = Math.max(metaLastAt ?? 0, userLastAt ?? 0);
    if (!isFinite(firstAt) || lastAt === 0) continue; // nothing real to roll up

    // Gap-based active time — raw event timestamps from
    // both the assistant side (code_assistant_meta) and the user side
    // (code_user_message rows), mirroring lib/pulse/cowork/session-aggregator.ts's
    // per-session raw-timestamp style. See lib/pulse/session-active-time.ts.
    const camTimestampRows = await client
      .select({ occurred_at: cam.occurred_at })
      .from(cam)
      .where(eq(cam.session_id, session_id));
    const userMsgTimestampRows = await client
      .select({ occurred_at: cm.occurred_at })
      .from(cm)
      .where(and(eq(cm.session_id, session_id), eq(cm.surface, 'code'), eq(cm.message_type, 'code_user_message')));
    const activeSecs = activeSecondsFromTimestamps([
      ...camTimestampRows.map(r => Number(r.occurred_at)),
      ...userMsgTimestampRows.map(r => Number(r.occurred_at)),
    ]);

    const values = {
      user_id: lastCtx?.user_id ?? userSideUserId ?? null,
      repo: deriveRepo(lastCtx?.cwd),
      git_branch: lastCtx?.git_branch || null,
      first_at: firstAt,
      last_at: lastAt,
      user_msg_count: userMsgs,
      assistant_turns: turns,
      tool_use_count: tools,
      error_count: errorsCount,
      commit_count: commits,
      input_tokens: inp,
      output_tokens: outp,
      cache_creation_tokens: cw,
      cache_read_tokens: cr,
      models_json: JSON.stringify(modelsJson),
      skills_json: JSON.stringify(skillRows.map(s => ({ name: s.skill_name, invocation_type: s.invocation_type }))),
      mcp_json: JSON.stringify(mcpRows.map(m => m.mcp_server)),
      computed_at: now,
      active_secs: activeSecs,
    };

    await client
      .insert(css)
      .values({ session_id, ...values })
      .onConflictDoUpdate({ target: css.session_id, set: values });
    updated++;
  }

  return updated;
}

// ─── Stage 2: scope metrics ──────────────────────────────────────────────────

interface SessionRow {
  session_id: string;
  user_id: string | null;
  repo: string | null;
  user_msg_count: number;
  tool_use_count: number;
  error_count: number;
  commit_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  models_json: string | null;
}

function computeScopeMetrics(sessions: SessionRow[], rates: ModelRates) {
  let inp = 0, outp = 0, cw = 0, cr = 0, tools = 0, msgs = 0, errors = 0, commits = 0;
  let spend = 0;
  let anyPriced = false;
  const repos = new Set<string>();

  for (const s of sessions) {
    inp += s.input_tokens; outp += s.output_tokens;
    cw += s.cache_creation_tokens; cr += s.cache_read_tokens;
    tools += s.tool_use_count; msgs += s.user_msg_count; errors += s.error_count;
    commits += s.commit_count;
    if (s.repo) repos.add(s.repo);

    if (s.models_json) {
      try {
        const models = JSON.parse(s.models_json) as Record<string, { input: number; output: number; cache_creation: number; cache_read: number }>;
        for (const [model, u] of Object.entries(models)) {
          const usd = priceTokens(model, {
            inputTokens: u.input, outputTokens: u.output,
            cacheCreationTokens: u.cache_creation, cacheReadTokens: u.cache_read,
          }, rates);
          if (usd !== null) { spend += usd; anyPriced = true; }
        }
      } catch { /* malformed rollup JSON — skip pricing for this session */ }
    }
  }

  const totalTokens = inp + outp + cw + cr;
  return {
    spendUsd: anyPriced ? spend : (totalTokens > 0 ? null : 0),
    inputTokens: inp,
    outputTokens: outp,
    cacheHitRatio: (cr + inp) > 0 ? cr / (cr + inp) : null,
    autonomyRatio: msgs > 0 ? tools / msgs : null,
    sessionCount: sessions.length,
    repoCount: repos.size,
    commitCount: commits,
    frictionIndex: tools > 0 ? errors / tools : null,
  };
}

/** Aggregate columns sourced from the OTel metrics stream (code_otel_metrics). */
export interface OtelMetricAgg {
  activeTimeUserS: number;
  activeTimeCliS: number;
  linesAdded: number;
  linesRemoved: number;
  prCount: number;
  editAccept: number;
  editReject: number;
}

const EMPTY_OTEL_AGG: OtelMetricAgg = {
  activeTimeUserS: 0, activeTimeCliS: 0, linesAdded: 0, linesRemoved: 0,
  prCount: 0, editAccept: 0, editReject: 0,
};

/**
 * Sum the Phase 1 OTel productivity metrics for a set of users over the window.
 *
 * SUM is only correct when the client exports DELTA temporality (each data point
 * is that interval's increment) — which managed settings are supposed to enforce
 * via OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta. It is NOT safe to
 * assume: OTLP's own default is CUMULATIVE, and a fleet exporting cumulative
 * running totals will SUM to a wildly inflated figure (~2,000x, measured on the
 * production instance, every metric affected, not just one). The receiver
 * currently discards the aggregationTemporality flag OTLP supplies, so this
 * function cannot tell the two apart. Verify the fleet's temporality before
 * trusting these numbers.
 */
export async function otelMetricsForUsers(userIds: string[], windowStart: number): Promise<OtelMetricAgg> {
  if (userIds.length === 0) return { ...EMPTY_OTEL_AGG };
  const client = await getTypedClient();
  const t = schema.codeOtelMetrics;
  const rows = await client
    .select({
      atu: sql<number | string>`COALESCE(SUM(CASE WHEN ${t.metric_name}='claude_code.active_time.total' AND ${t.type}='user' THEN ${t.value} END),0)`,
      atc: sql<number | string>`COALESCE(SUM(CASE WHEN ${t.metric_name}='claude_code.active_time.total' AND ${t.type}='cli' THEN ${t.value} END),0)`,
      la: sql<number | string>`COALESCE(SUM(CASE WHEN ${t.metric_name}='claude_code.lines_of_code.count' AND ${t.type}='added' THEN ${t.value} END),0)`,
      lr: sql<number | string>`COALESCE(SUM(CASE WHEN ${t.metric_name}='claude_code.lines_of_code.count' AND ${t.type}='removed' THEN ${t.value} END),0)`,
      prc: sql<number | string>`COALESCE(SUM(CASE WHEN ${t.metric_name}='claude_code.pull_request.count' THEN ${t.value} END),0)`,
      ea: sql<number | string>`COALESCE(SUM(CASE WHEN ${t.metric_name}='claude_code.code_edit_tool.decision' AND ${t.type}='accept' THEN ${t.value} END),0)`,
      er: sql<number | string>`COALESCE(SUM(CASE WHEN ${t.metric_name}='claude_code.code_edit_tool.decision' AND ${t.type}='reject' THEN ${t.value} END),0)`,
    })
    .from(t)
    .where(and(inArray(t.user_id, userIds), gte(t.occurred_at, windowStart)));
  const row = rows[0];
  return {
    activeTimeUserS: Math.round(Number(row?.atu ?? 0)),
    activeTimeCliS: Math.round(Number(row?.atc ?? 0)),
    linesAdded: Math.round(Number(row?.la ?? 0)),
    linesRemoved: Math.round(Number(row?.lr ?? 0)),
    prCount: Math.round(Number(row?.prc ?? 0)),
    editAccept: Math.round(Number(row?.ea ?? 0)),
    editReject: Math.round(Number(row?.er ?? 0)),
  };
}

async function skillLeverageForUsers(client: TypedClient, userIds: string[], windowStart: number): Promise<number | null> {
  if (userIds.length === 0) return null;
  const csi = schema.coworkSkillInvocations;
  const css = schema.codeSessionStats;
  // Code-surface skill invocations only: restrict to sessions present in code_session_stats.
  const rows = await client
    .select({
      chained: sql<number | string>`SUM(CASE WHEN ${csi.invocation_type} = 'agent_chained' THEN 1 ELSE 0 END)`,
      total: sql<number | string>`COUNT(*)`,
    })
    .from(csi)
    .innerJoin(css, eq(css.session_id, csi.session_id))
    .where(and(inArray(csi.user_id, userIds), gte(csi.occurred_at, windowStart)));
  const row = rows[0];
  const total = Number(row?.total ?? 0);
  if (!total) return null;
  return Number(row?.chained ?? 0) / total;
}

async function writeCodeMetric(
  client: TypedClient, scopeType: string, scopeId: string, periodStart: number, periodEnd: number,
  m: ReturnType<typeof computeScopeMetrics>, skillLeverage: number | null, otel: OtelMetricAgg,
  granularity: 'rolling' | 'week' = 'rolling',
): Promise<void> {
  const t = schema.codeMetrics;
  const computedAt = Math.floor(Date.now() / 1000);

  // spend_usd is `numeric` (Drizzle requires a STRING on write to avoid float
  // precision loss) — String()-encode once here, mirroring lib/pulse/cowork/
  // session-aggregator.ts's total_cost_usd write.
  const values = {
    scope_type: scopeType,
    scope_id: scopeId,
    period_start: periodStart,
    period_end: periodEnd,
    spend_usd: m.spendUsd !== null ? String(m.spendUsd) : null,
    input_tokens: m.inputTokens,
    output_tokens: m.outputTokens,
    cache_hit_ratio: m.cacheHitRatio,
    autonomy_ratio: m.autonomyRatio,
    session_count: m.sessionCount,
    repo_count: m.repoCount,
    commit_count: m.commitCount,
    skill_leverage: skillLeverage,
    friction_index: m.frictionIndex,
    active_time_user_s: otel.activeTimeUserS,
    active_time_cli_s: otel.activeTimeCliS,
    lines_added: otel.linesAdded,
    lines_removed: otel.linesRemoved,
    pr_count: otel.prCount,
    edit_accept_count: otel.editAccept,
    edit_reject_count: otel.editReject,
    computed_at: computedAt,
  };

  if (granularity === 'rolling') {
    // The unique index is partial (WHERE granularity='week'), so it never
    // applies to a 'rolling' row: a plain insert always appends a fresh
    // time-stamped snapshot and can never collide.
    await client.insert(t).values({ ...values, granularity: 'rolling' });
    return;
  }

  // Weekly rows are upserted — one row per (scope_type, scope_id, period_start)
  // where granularity='week', keyed on the partial unique index. Naming the
  // predicate via targetWhere lets Postgres infer the partial index as the
  // arbiter.
  await client
    .insert(t)
    .values({ ...values, granularity: 'week' })
    .onConflictDoUpdate({
      target: [t.scope_type, t.scope_id, t.period_start],
      targetWhere: sql`granularity = 'week'`,
      set: {
        period_end: values.period_end,
        spend_usd: values.spend_usd,
        input_tokens: values.input_tokens,
        output_tokens: values.output_tokens,
        cache_hit_ratio: values.cache_hit_ratio,
        autonomy_ratio: values.autonomy_ratio,
        session_count: values.session_count,
        repo_count: values.repo_count,
        commit_count: values.commit_count,
        skill_leverage: values.skill_leverage,
        friction_index: values.friction_index,
        active_time_user_s: values.active_time_user_s,
        active_time_cli_s: values.active_time_cli_s,
        lines_added: values.lines_added,
        lines_removed: values.lines_removed,
        pr_count: values.pr_count,
        edit_accept_count: values.edit_accept_count,
        edit_reject_count: values.edit_reject_count,
        computed_at: values.computed_at,
      },
    });
}

export async function runCodeHourlyAggregation(): Promise<void> {
  const client = await getTypedClient();
  console.log('[CodePulse] Running hourly aggregation...');

  // Captured BEFORE the rollup: events ingested while this run executes fall
  // after this mark and are picked up (re-rolled idempotently) next cycle.
  const runStartIso = new Date().toISOString();

  // A production incident: this used to only advance codeAggregatorLastRun
  // on success (at the bottom of this function). A thrown error — e.g. the
  // active_time_cli_s overflow above — meant the scheduler's hourly gate never
  // saw a lastRun and retried the ENTIRE aggregation (including the per-session
  // rollup loop) every single scheduler tick (default 60s) indefinitely. The
  // try/finally guarantees a backoff to the normal hourly cadence regardless of
  // outcome; the error still propagates so the scheduler logs it as before.
  try {
    await runCodeHourlyAggregationInner(client);
  } finally {
    await setConfigValue('codeAggregatorLastRun', runStartIso);
  }
}

async function runCodeHourlyAggregationInner(client: TypedClient): Promise<void> {
  const updated = await rollupCodeSessionStats();
  console.log(`[CodePulse] Session rollup: ${updated} session(s) updated`);

  const now = Math.floor(Date.now() / 1000);
  const rates = await getCodeModelRates();

  // Bound the scan to the rolling 7-day window at the SQL level — the weekly
  // (calendar-week) window is always a subset of the rolling window, since a
  // calendar week's start is at most 7 days back from `now`, so this single
  // query covers both writers below; the JS filters partition rolling vs
  // weekly sessions on top of this already-bounded set.
  const rollingPeriodStart = now - SEVEN_DAYS;
  const css = schema.codeSessionStats;
  const allSessions = await client
    .select({
      session_id: css.session_id,
      user_id: css.user_id,
      repo: css.repo,
      user_msg_count: css.user_msg_count,
      tool_use_count: css.tool_use_count,
      error_count: css.error_count,
      commit_count: css.commit_count,
      input_tokens: css.input_tokens,
      output_tokens: css.output_tokens,
      cache_creation_tokens: css.cache_creation_tokens,
      cache_read_tokens: css.cache_read_tokens,
      models_json: css.models_json,
      last_at: css.last_at,
    })
    .from(css)
    .where(gte(css.last_at, rollingPeriodStart));

  /**
   * Write org/user/team/function scope rows for a given session window.
   * Shared by both the rolling (7-day) and weekly (calendar-week) writes so
   * the team/department member-resolution logic exists exactly once.
   */
  async function writeScopes(sessions: SessionRow[], periodStart: number, granularity: 'rolling' | 'week'): Promise<void> {
    // Organisation scope
    const orgUserIds = [...new Set(sessions.map(s => s.user_id).filter((u): u is string => !!u))];
    await writeCodeMetric(client, 'organisation', ORG_SCOPE_ID, periodStart, now,
      computeScopeMetrics(sessions, rates), await skillLeverageForUsers(client, orgUserIds, periodStart),
      await otelMetricsForUsers(orgUserIds, periodStart), granularity);

    // User scope
    for (const userId of orgUserIds) {
      const userSessions = sessions.filter(s => s.user_id === userId);
      await writeCodeMetric(client, 'user', userId, periodStart, now,
        computeScopeMetrics(userSessions, rates), await skillLeverageForUsers(client, [userId], periodStart),
        await otelMetricsForUsers([userId], periodStart), granularity);
    }

    // Team scope (users.team_id)
    const teams = await client
      .selectDistinct({ team_id: schema.users.team_id })
      .from(schema.users)
      .where(isNotNull(schema.users.team_id));
    for (const { team_id } of teams) {
      if (!team_id) continue;
      const memberRows = await client
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.team_id, team_id));
      const memberIds = memberRows.map(r => r.id);
      const memberSet = new Set(memberIds);
      const teamSessions = sessions.filter(s => s.user_id && memberSet.has(s.user_id));
      if (teamSessions.length === 0) continue;
      await writeCodeMetric(client, 'team', team_id, periodStart, now,
        computeScopeMetrics(teamSessions, rates), await skillLeverageForUsers(client, memberIds, periodStart),
        await otelMetricsForUsers(memberIds, periodStart), granularity);
    }

    // Department scope — members come from BOTH resolution paths the Cowork
    // aggregators use: users.department (daily aggregation) and the
    // admin_users.department → linked_cowork_user_id chain (hourly).
    const deptMembers = new Map<string, Set<string>>();
    const addMember = (dept: string, userId: string) => {
      if (!deptMembers.has(dept)) deptMembers.set(dept, new Set());
      deptMembers.get(dept)!.add(userId);
    };
    const usersDeptRows = await client
      .select({ id: schema.users.id, department: schema.users.department })
      .from(schema.users)
      .where(and(isNotNull(schema.users.department), ne(schema.users.department, '')));
    for (const row of usersDeptRows) {
      if (row.department) addMember(row.department, row.id);
    }
    const adminDeptRows = await client
      .select({ id: schema.adminUsers.linked_cowork_user_id, department: schema.adminUsers.department })
      .from(schema.adminUsers)
      .where(and(
        isNotNull(schema.adminUsers.department),
        ne(schema.adminUsers.department, ''),
        isNotNull(schema.adminUsers.linked_cowork_user_id),
      ));
    for (const row of adminDeptRows) {
      if (row.department && row.id) addMember(row.department, row.id);
    }
    for (const [department, memberSet] of deptMembers) {
      const deptSessions = sessions.filter(s => s.user_id && memberSet.has(s.user_id));
      if (deptSessions.length === 0) continue;
      const memberIds = [...memberSet];
      await writeCodeMetric(client, 'function', department, periodStart, now,
        computeScopeMetrics(deptSessions, rates), await skillLeverageForUsers(client, memberIds, periodStart),
        await otelMetricsForUsers(memberIds, periodStart), granularity);
    }
  }

  // Rolling 7-day window (existing behaviour — byte-for-byte unchanged rows)
  const rollingSessions = allSessions.filter(s => s.last_at >= rollingPeriodStart);
  await writeScopes(rollingSessions, rollingPeriodStart, 'rolling');

  // Calendar-week window (new) — upserted, immutable once the week rolls over.
  // Weekly rows attribute a session's FULL totals to the week containing its
  // last_at — a session spanning the Monday 00:00 UTC boundary contributes
  // its whole-session totals to both adjacent weeks' rolling writes, and any
  // sub-hour tail activity after the week's final hourly run never reaches
  // the completed row.
  const weeklyPeriodStart = weekStart(now);
  const weeklySessions = allSessions.filter(s => s.last_at >= weeklyPeriodStart);
  await writeScopes(weeklySessions, weeklyPeriodStart, 'week');

  // Deterministic alert evaluation — runs after rollups so it sees fresh stats
  await runCodePulseAlerts();

  console.log('[CodePulse] Hourly aggregation complete.');
}
