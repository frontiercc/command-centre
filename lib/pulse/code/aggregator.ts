// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Developer Pulse aggregator — deterministic, no classifier.
 *
 * Two stages, run on the hourly scheduler cycle:
 *   1. rollupCodeSessionStats() — recompute per-session rollups for sessions
 *      with new activity since the last run (high-water mark on ingested_at).
 *   2. runCodeHourlyAggregation() — write code_metrics snapshots per scope
 *      (user / team / function / organisation): 'rolling' over the last 30
 *      days, 'rolling_prior' over the 30 days before that (the comparison),
 *      'rolling_7d' over the last 7 days (the weekly readers), and 'week' per
 *      calendar week.
 *
 * Follows the pattern in lib/db/error-queries.ts / lib/db/queries.ts and
 * mirrors lib/pulse/aggregator.ts's writeMetric for the
 * code_metrics rolling/week write semantics: 'rolling', 'rolling_prior' and
 * 'rolling_7d' rows are a plain insert (the partial unique index
 * `idx_code_metrics_week` — WHERE granularity='week' — can never match them,
 * so they always append);
 * 'week' rows are upserted via onConflictDoUpdate with
 * `targetWhere: sql\`granularity = 'week'\`` as the partial index arbiter.
 */
import { and, eq, gte, inArray, isNotNull, lt, ne, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue, setConfigValue } from '@/lib/config';
import { getCodeModelRates, priceTokens, type ModelRates } from '@/lib/pulse/code/rates';
import { runCodePulseAlerts } from '@/lib/alerts/code-pulse-alerts';
import { weekStart, weekStarts } from '@/lib/pulse/period';
import { activeSecondsFromTimestamps } from '@/lib/pulse/session-active-time';
import { codexSpend } from '@/lib/openai/spend';

const DAY = 24 * 60 * 60;
/** Developer Pulse's headline window: the last 30 days, compared with the 30 days before. */
export const ROLLING_WINDOW_DAYS = 30;
const ROLLING_WINDOW = ROLLING_WINDOW_DAYS * DAY;
/** The weekly readers' window (the This week in Code briefing, the dashboard briefing, Person 360). */
const SEVEN_DAYS = 7 * DAY;
export const ORG_SCOPE_ID = 'org';

/**
 * The snapshot kinds the hourly run writes. 'rolling' is the last 30 days,
 * 'rolling_prior' the 30 days before that, 'rolling_7d' the last 7 days; all
 * three append a fresh row each run. 'week' is one upserted row per calendar week.
 */
export type CodeMetricGranularity = 'rolling' | 'rolling_prior' | 'rolling_7d' | 'week';

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

  // Sessions with new assistant metadata, new code user messages or new Codex
  // actions. A UNION of differently-shaped tables — kept as raw SQL (Rule 2).
  const dirty = await rawAll<{ session_id: string }>(client, sql`
     SELECT session_id FROM code_assistant_meta WHERE ingested_at >= ${since}
     UNION
     SELECT session_id FROM cowork_messages
     WHERE surface = 'code' AND message_type = 'code_user_message' AND ingested_at >= ${since}
     UNION
     SELECT session_id FROM codex_actions WHERE ingested_at >= ${since}
  `);

  const cam = schema.codeAssistantMeta;
  const cm = schema.coworkMessages;
  const csi = schema.coworkSkillInvocations;
  const cmi = schema.coworkMcpInvocations;
  const css = schema.codeSessionStats;

  const now = Math.floor(Date.now() / 1000);
  let updated = 0;

  for (const { session_id } of dirty) {
    // Assistant side: ONE read of the session's model-call rows, summed here.
    // This used to be four separate queries (totals, latest cwd, per-model
    // totals, timestamps), each re-reading every row of the session. A
    // long-lived session has tens of thousands of rows and is recomputed every
    // hour while it is active, so on a database whose data no longer fits in
    // memory that was four full passes from disk per session per hour. Per-call
    // counts are small integers, so plain JS sums are exact.
    const camRows = await client
      .select({
        model: cam.model,
        tool_use_count: cam.tool_use_count,
        error_count: cam.error_count,
        commit_count: cam.commit_count,
        input_tokens: cam.input_tokens,
        output_tokens: cam.output_tokens,
        cache_creation_tokens: cam.cache_creation_tokens,
        cache_read_tokens: cam.cache_read_tokens,
        occurred_at: cam.occurred_at,
        user_id: cam.user_id,
        cwd: cam.cwd,
        git_branch: cam.git_branch,
      })
      .from(cam)
      .where(eq(cam.session_id, session_id));

    let turns = 0, tools = 0, errorsCount = 0, commits = 0, inp = 0, outp = 0, cw = 0, cr = 0;
    let metaFirstAt: number | null = null;
    let metaLastAt: number | null = null;
    let lastCtx: { user_id: string | null; cwd: string | null; git_branch: string | null } | undefined;
    let lastCtxAt = -Infinity;
    const modelsJson: Record<string, { input: number; output: number; cache_creation: number; cache_read: number }> = {};
    const camTimestamps: number[] = [];
    for (const r of camRows) {
      const at = Number(r.occurred_at);
      const rIn = Number(r.input_tokens ?? 0);
      const rOut = Number(r.output_tokens ?? 0);
      const rCw = Number(r.cache_creation_tokens ?? 0);
      const rCr = Number(r.cache_read_tokens ?? 0);
      tools += Number(r.tool_use_count ?? 0);
      errorsCount += Number(r.error_count ?? 0);
      commits += Number(r.commit_count ?? 0);
      inp += rIn; outp += rOut; cw += rCw; cr += rCr;
      camTimestamps.push(at);
      if (metaFirstAt === null || at < metaFirstAt) metaFirstAt = at;
      if (metaLastAt === null || at > metaLastAt) metaLastAt = at;
      if (r.model) {
        turns++;
        const m = (modelsJson[r.model] ??= { input: 0, output: 0, cache_creation: 0, cache_read: 0 });
        m.input += rIn; m.output += rOut; m.cache_creation += rCw; m.cache_read += rCr;
      }
      // Latest row that recorded a working directory (>= keeps the later row on a tie).
      if (r.cwd && at >= lastCtxAt) {
        lastCtxAt = at;
        lastCtx = { user_id: r.user_id, cwd: r.cwd, git_branch: r.git_branch };
      }
    }

    // User side: one read of the session's prompt rows (was a summary query
    // plus a second read of the same rows for their timestamps).
    const userRows = await client
      .select({ occurred_at: cm.occurred_at, user_id: cm.user_id })
      .from(cm)
      .where(and(eq(cm.session_id, session_id), eq(cm.surface, 'code'), eq(cm.message_type, 'code_user_message')));
    const userMsgs = userRows.length;
    let userFirstAt: number | null = null;
    let userLastAt: number | null = null;
    let userSideUserId: string | null = null;
    const userTimestamps: number[] = [];
    for (const r of userRows) {
      const at = Number(r.occurred_at);
      userTimestamps.push(at);
      if (userFirstAt === null || at < userFirstAt) userFirstAt = at;
      if (userLastAt === null || at > userLastAt) userLastAt = at;
      // Same pick as the old MAX(user_id): the highest id in the session.
      if (r.user_id && (userSideUserId === null || r.user_id > userSideUserId)) userSideUserId = r.user_id;
    }

    const skillRows = await client
      .select({ skill_name: csi.skill_name, invocation_type: csi.invocation_type })
      .from(csi)
      .where(eq(csi.session_id, session_id));

    const mcpRows = await client
      .selectDistinct({ mcp_server: cmi.mcp_server })
      .from(cmi)
      .where(eq(cmi.session_id, session_id));

    // A Codex session's actions (codex_actions) mark when it was working,
    // as Claude Code's assistant rows do. Their counts stay out of this row:
    // per-product figures read them apart (code_metrics_vendor).
    const codexActionTs = session_id.startsWith('codex:')
      ? (await client.select({ occurred_at: schema.codexActions.occurred_at })
          .from(schema.codexActions).where(eq(schema.codexActions.session_id, session_id)))
          .map(r => Number(r.occurred_at))
      : [];
    const firstAt = Math.min(metaFirstAt ?? Infinity, userFirstAt ?? Infinity, ...codexActionTs);
    const lastAt = Math.max(metaLastAt ?? 0, userLastAt ?? 0, ...codexActionTs);
    if (!isFinite(firstAt) || lastAt === 0) continue; // nothing real to roll up

    // Gap-based active time — raw event timestamps from
    // both the assistant side (code_assistant_meta) and the user side
    // (code_user_message rows), mirroring lib/pulse/cowork/session-aggregator.ts's
    // per-session raw-timestamp style. See lib/pulse/session-active-time.ts.
    const activeSecs = activeSecondsFromTimestamps([
      ...camTimestamps,
      ...userTimestamps,
      ...codexActionTs,
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
export async function otelMetricsForUsers(userIds: string[], windowStart: number, windowEnd?: number): Promise<OtelMetricAgg> {
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
    .where(and(inArray(t.user_id, userIds), gte(t.occurred_at, windowStart), windowEnd !== undefined ? lt(t.occurred_at, windowEnd) : undefined));
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

async function skillLeverageForUsers(client: TypedClient, userIds: string[], windowStart: number, windowEnd?: number): Promise<number | null> {
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
    .where(and(inArray(csi.user_id, userIds), gte(csi.occurred_at, windowStart), windowEnd !== undefined ? lt(csi.occurred_at, windowEnd) : undefined));
  const row = rows[0];
  const total = Number(row?.total ?? 0);
  if (!total) return null;
  return Number(row?.chained ?? 0) / total;
}

/** Completed weeks the per-product weekly rows are kept up to date over. */
const PAST_VENDOR_WEEKS = 13;
const WEEK = 7 * 24 * 60 * 60;

/** The three per-product views code_metrics_vendor holds. */
export type CodeVendor = 'all' | 'claude' | 'openai';

async function writeCodeMetric(
  client: TypedClient, scopeType: string, scopeId: string, periodStart: number, periodEnd: number,
  m: ReturnType<typeof computeScopeMetrics>, skillLeverage: number | null, otel: OtelMetricAgg,
  granularity: CodeMetricGranularity = 'rolling',
  vendor?: CodeVendor,
): Promise<void> {
  if (vendor) return writeVendorMetric(client, vendor, scopeType, scopeId, periodStart, periodEnd, m, skillLeverage, otel, granularity);
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

  if (granularity !== 'week') {
    // The unique index is partial (WHERE granularity='week'), so it never
    // applies to a rolling row: a plain insert always appends a fresh
    // time-stamped snapshot and can never collide.
    await client.insert(t).values({ ...values, granularity });
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

/** Same row as writeCodeMetric, into code_metrics_vendor for one product view. */
async function writeVendorMetric(
  client: TypedClient, vendor: CodeVendor, scopeType: string, scopeId: string, periodStart: number, periodEnd: number,
  m: ReturnType<typeof computeScopeMetrics>, skillLeverage: number | null, otel: OtelMetricAgg,
  granularity: CodeMetricGranularity,
): Promise<void> {
  const t = schema.codeMetricsVendor;
  const set = {
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
    computed_at: Math.floor(Date.now() / 1000),
  };
  const values = { vendor, scope_type: scopeType, scope_id: scopeId, period_start: periodStart, ...set, granularity };
  if (granularity !== 'week') {
    await client.insert(t).values(values);
    return;
  }
  await client.insert(t).values(values).onConflictDoUpdate({
    target: [t.vendor, t.scope_type, t.scope_id, t.period_start],
    targetWhere: sql`granularity = 'week'`,
    set,
  });
}

const isCodexSession = (s: { session_id: string }) => s.session_id.startsWith('codex:');

/**
 * Codex actions, failures and commits per session, from codex_actions, so a
 * Codex session's row in the per-product figures counts them the way a Claude
 * Code session counts its tool calls and commits.
 */
/** Actions, failed actions and commits per Codex session, from codex_actions. */
export async function codexActionCounts(client: TypedClient, sessionIds: string[]): Promise<Map<string, { tools: number; errors: number; commits: number }>> {
  const out = new Map<string, { tools: number; errors: number; commits: number }>();
  const ca = schema.codexActions;
  for (let i = 0; i < sessionIds.length; i += 500) {
    const rows = await client
      .select({
        session_id: ca.session_id,
        tools: sql<number | string>`COUNT(*)`,
        errors: sql<number | string>`COALESCE(SUM(${ca.failed}), 0)`,
        commits: sql<number | string>`COALESCE(SUM(${ca.commit_count}), 0)`,
      })
      .from(ca)
      .where(inArray(ca.session_id, sessionIds.slice(i, i + 500)))
      .groupBy(ca.session_id);
    for (const r of rows) out.set(r.session_id, { tools: Number(r.tools), errors: Number(r.errors), commits: Number(r.commits) });
  }
  return out;
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

  // Bound the scan at the SQL level to the start of the prior 30-day window
  // (60 days back). Every window below is a subset of it: the last 30 days,
  // the 30 before, the last 7 days, and the calendar week (whose start is at
  // most 7 days back from `now`), so this single query covers every writer;
  // the JS filters partition the sessions on top of this already-bounded set.
  const rollingPeriodStart = now - ROLLING_WINDOW;
  const priorPeriodStart = rollingPeriodStart - ROLLING_WINDOW;
  const sevenDayPeriodStart = now - SEVEN_DAYS;
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
    .where(gte(css.last_at, priorPeriodStart));

  /**
   * Write org/user/team/function scope rows for a given session window.
   * Shared by the rolling (30-day, prior 30-day, 7-day) and weekly
   * (calendar-week) writes so the team/department member-resolution logic
   * exists exactly once. `periodEnd` bounds a window that ends before now
   * (the prior 30 days); omitted, the window runs to now.
   */
  type ScopeWriter = (scopeType: string, scopeId: string, scopeSessions: SessionRow[], memberIds: string[], isOrg: boolean) => Promise<void>;

  async function writeScopes(sessions: SessionRow[], periodStart: number, granularity: CodeMetricGranularity, writer?: ScopeWriter, periodEnd?: number): Promise<void> {
    const write: ScopeWriter = writer ?? (async (scopeType, scopeId, scopeSessions, memberIds) => {
      await writeCodeMetric(client, scopeType, scopeId, periodStart, periodEnd ?? now,
        computeScopeMetrics(scopeSessions, rates), await skillLeverageForUsers(client, memberIds, periodStart, periodEnd),
        await otelMetricsForUsers(memberIds, periodStart, periodEnd), granularity);
    });

    // Organisation scope
    const orgUserIds = [...new Set(sessions.map(s => s.user_id).filter((u): u is string => !!u))];
    await write('organisation', ORG_SCOPE_ID, sessions, orgUserIds, true);

    // User scope
    for (const userId of orgUserIds) {
      await write('user', userId, sessions.filter(s => s.user_id === userId), [userId], false);
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
      await write('team', team_id, teamSessions, memberIds, false);
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
      await write('function', department, deptSessions, memberIds, false);
    }
  }

  // A session belongs to a window by its last_at, as everywhere in Developer Pulse.
  const inRolling = (s: { last_at: number }) => s.last_at >= rollingPeriodStart;
  const inPrior = (s: { last_at: number }) => s.last_at >= priorPeriodStart && s.last_at < rollingPeriodStart;
  const inSevenDays = (s: { last_at: number }) => s.last_at >= sevenDayPeriodStart;

  // The last 30 days (the headline figures), the 30 days before them (what
  // they are compared with), and the last 7 days (the weekly readers).
  await writeScopes(allSessions.filter(inRolling), rollingPeriodStart, 'rolling');
  await writeScopes(allSessions.filter(inPrior), priorPeriodStart, 'rolling_prior', undefined, rollingPeriodStart);
  await writeScopes(allSessions.filter(inSevenDays), sevenDayPeriodStart, 'rolling_7d');

  // Calendar-week window (new) — upserted, immutable once the week rolls over.
  // Weekly rows attribute a session's FULL totals to the week containing its
  // last_at — a session spanning the Monday 00:00 UTC boundary contributes
  // its whole-session totals to both adjacent weeks' rolling writes, and any
  // sub-hour tail activity after the week's final hourly run never reaches
  // the completed row.
  const weeklyPeriodStart = weekStart(now);
  const weeklySessions = allSessions.filter(s => s.last_at >= weeklyPeriodStart);
  await writeScopes(weeklySessions, weeklyPeriodStart, 'week');

  // Per-product figures (code_metrics_vendor), once Codex data exists: all
  // products, Claude Code only and Codex only. A Codex session counts its
  // actions, failures and commits from codex_actions; Codex spend and tokens
  // come from its turns, priced from the rates table. Claude Code's telemetry
  // columns are Claude Code's alone, so the Codex view carries none.
  const codexPresent = (await rawAll<{ x: number }>(client, sql`SELECT 1 AS x FROM cowork_messages WHERE source = 'codex' LIMIT 1`)).length > 0;
  if (codexPresent) {
    const counts = await codexActionCounts(client, allSessions.filter(isCodexSession).map(s => s.session_id));
    const augmented: Array<SessionRow & { last_at: number }> = allSessions.map(s => {
      const c = isCodexSession(s) ? counts.get(s.session_id) : undefined;
      return isCodexSession(s)
        ? { ...s, tool_use_count: c?.tools ?? 0, error_count: c?.errors ?? 0, commit_count: c?.commits ?? 0 }
        : s;
    });
    // periodEnd is now for the current windows; a past week (below) passes its end, which also bounds every query.
    const vendorWriter = (vendor: CodeVendor, periodStart: number, granularity: CodeMetricGranularity, periodEnd?: number): ScopeWriter =>
      async (scopeType, scopeId, scopeSessions, memberIds, isOrg) => {
        const end = periodEnd ?? now;
        const base = computeScopeMetrics(scopeSessions, rates);
        const skill = vendor === 'openai' ? null : await skillLeverageForUsers(client, memberIds, periodStart, periodEnd);
        if (vendor === 'claude') {
          await writeCodeMetric(client, scopeType, scopeId, periodStart, end, base, skill,
            await otelMetricsForUsers(memberIds, periodStart, periodEnd), granularity, vendor);
          return;
        }
        const codex = await codexSpend({ since: periodStart, until: periodEnd, userIds: isOrg ? undefined : memberIds }, rates);
        const codexUsd = codex.turns === 0 ? 0 : codex.usd;
        if (vendor === 'openai') {
          const m = {
            ...base,
            spendUsd: codexUsd,
            // Input excludes cached tokens, as Claude Code's does; they count in the cache-hit ratio.
            inputTokens: codex.inputTokens,
            outputTokens: codex.outputTokens,
            cacheHitRatio: codex.inputTokens + codex.cachedTokens > 0 ? codex.cachedTokens / (codex.inputTokens + codex.cachedTokens) : null,
          };
          await writeCodeMetric(client, scopeType, scopeId, periodStart, end, m, skill, { ...EMPTY_OTEL_AGG }, granularity, vendor);
          return;
        }
        // All products: Claude Code's figures plus Codex's.
        const claude = scopeSessions.filter(s => !isCodexSession(s));
        const claudeInp = claude.reduce((n, s) => n + s.input_tokens, 0);
        const claudeCr = claude.reduce((n, s) => n + s.cache_read_tokens, 0);
        const cacheDen = claudeInp + claudeCr + codex.inputTokens + codex.cachedTokens;
        const m = {
          ...base,
          spendUsd: base.spendUsd === null && codexUsd === null ? null : (base.spendUsd ?? 0) + (codexUsd ?? 0),
          inputTokens: base.inputTokens + codex.inputTokens,
          outputTokens: base.outputTokens + codex.outputTokens,
          cacheHitRatio: cacheDen > 0 ? (claudeCr + codex.cachedTokens) / cacheDen : null,
        };
        await writeCodeMetric(client, scopeType, scopeId, periodStart, end, m, skill,
          await otelMetricsForUsers(memberIds, periodStart, periodEnd), granularity, vendor);
      };
    for (const vendor of ['all', 'claude', 'openai'] as const) {
      const pick = (rows: typeof augmented) => vendor === 'all' ? rows : rows.filter(s => isCodexSession(s) === (vendor === 'openai'));
      await writeScopes(pick(augmented.filter(inRolling)), rollingPeriodStart, 'rolling', vendorWriter(vendor, rollingPeriodStart, 'rolling'));
      await writeScopes(pick(augmented.filter(inPrior)), priorPeriodStart, 'rolling_prior', vendorWriter(vendor, priorPeriodStart, 'rolling_prior', rollingPeriodStart));
      await writeScopes(pick(augmented.filter(inSevenDays)), sevenDayPeriodStart, 'rolling_7d', vendorWriter(vendor, sevenDayPeriodStart, 'rolling_7d'));
      await writeScopes(pick(augmented.filter(s => s.last_at >= weeklyPeriodStart)), weeklyPeriodStart, 'week', vendorWriter(vendor, weeklyPeriodStart, 'week'));
    }

    // Completed weeks whose sessions changed since the last run (every week
    // the first time) are recounted from the session stats, each bounded to
    // its week: the table only gains a week while this runs with Codex data
    // present, and a week written before a late session (a Codex backfill)
    // arrived would otherwise stay short. Weeks with no changed session are
    // left exactly as they are. Five minutes of overlap, as in Work Pulse.
    const changedSince = Number(await getConfigValue('codeVendorWeeksChangedSince')) || 0;
    const runStart = Math.floor(Date.now() / 1000);
    const pastFrom = weekStarts(weeklyPeriodStart - 1, PAST_VENDOR_WEEKS)[0];
    const lastAtWeek = sql<number | string>`(${css.last_at} - (((${css.last_at} / 86400) + 3) % 7) * 86400 - (${css.last_at} % 86400))`;
    const changedWeeks = (await client
      .selectDistinct({ week: lastAtWeek })
      .from(css)
      .where(and(gte(css.last_at, pastFrom), lt(css.last_at, weeklyPeriodStart), gte(css.computed_at, changedSince))))
      .map(r => Number(r.week))
      .sort((a, b) => b - a);
    for (const week of changedWeeks) {
      const weekEnd = week + WEEK;
      const sessions = await client
        .select({
          session_id: css.session_id, user_id: css.user_id, repo: css.repo,
          user_msg_count: css.user_msg_count, tool_use_count: css.tool_use_count, error_count: css.error_count,
          commit_count: css.commit_count, input_tokens: css.input_tokens, output_tokens: css.output_tokens,
          cache_creation_tokens: css.cache_creation_tokens, cache_read_tokens: css.cache_read_tokens,
          models_json: css.models_json, last_at: css.last_at,
        })
        .from(css)
        .where(and(gte(css.last_at, week), lt(css.last_at, weekEnd)));
      const weekCounts = await codexActionCounts(client, sessions.filter(isCodexSession).map(s => s.session_id));
      const weekSessions: Array<SessionRow & { last_at: number }> = sessions.map(s => {
        const c = isCodexSession(s) ? weekCounts.get(s.session_id) : undefined;
        return isCodexSession(s)
          ? { ...s, tool_use_count: c?.tools ?? 0, error_count: c?.errors ?? 0, commit_count: c?.commits ?? 0 }
          : s;
      });
      for (const vendor of ['all', 'claude', 'openai'] as const) {
        const rows = vendor === 'all' ? weekSessions : weekSessions.filter(s => isCodexSession(s) === (vendor === 'openai'));
        await writeScopes(rows, week, 'week', vendorWriter(vendor, week, 'week', weekEnd));
      }
    }
    await setConfigValue('codeVendorWeeksChangedSince', String(runStart - 300));
  }

  // Deterministic alert evaluation — runs after rollups so it sees fresh stats
  await runCodePulseAlerts();

  console.log('[CodePulse] Hourly aggregation complete.');
}
