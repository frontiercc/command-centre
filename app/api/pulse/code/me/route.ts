// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern (lib/pulse/code/aggregator.ts, the
// route app/api/pulse/cio/route.ts): getTypedClient() + schema.<table>, the
// query builder for aggregates/joins, a correlated-subquery raw sql for the
// per-session "source" column (clearer than the builder's subquery syntax
// here). Every SUM/COUNT aggregate is Number()-coerced (Postgres returns bigint and numeric as strings).
import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { getAdminSession, isDeptScoped, canAccessCodePulse } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getCodeModelRates, priceTokens } from '@/lib/pulse/code/rates';
import { getWeeklySeries, getWeeklyDelta } from '@/lib/pulse/trends';
import { readHumanTime } from '@/lib/pulse/human-time-summary';
import { getAllConfig } from '@/lib/config';
import { canViewSpendReview } from '@/lib/finance/spend-review-access';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessCodePulse(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const client = await getTypedClient();
  const au = schema.adminUsers;
  const u = schema.users;
  const cm = schema.codeMetrics;
  const css = schema.codeSessionStats;
  const cam = schema.codeAssistantMeta;
  const csc = schema.codeSessionClassifications;

  // Same resolution chain as /api/pulse/me: linked_cowork_user_id first, email second
  async function resolveMyUserId(): Promise<string | null> {
    const linkedRows = await client
      .select({ linked_cowork_user_id: au.linked_cowork_user_id })
      .from(au)
      .where(eq(au.email, session.email!))
      .limit(1);
    if (linkedRows[0]?.linked_cowork_user_id) return linkedRows[0].linked_cowork_user_id;
    const byEmailRows = await client
      .select({ id: u.id })
      .from(u)
      .where(eq(u.email, session.email!))
      .limit(1);
    return byEmailRows[0]?.id ?? null;
  }

  let userId: string | null = null;
  const queryUserId = request.nextUrl.searchParams.get('userId');
  if (queryUserId) {
    if (session.role === 'admin' || session.role === 'manager') {
      userId = queryUserId;
    } else if (isDeptScoped(session.role) && session.department) {
      const targetAdminRows = await client
        .select({ department: au.department })
        .from(au)
        .where(eq(au.linked_cowork_user_id, queryUserId))
        .limit(1);
      if (targetAdminRows[0]?.department === session.department) {
        userId = queryUserId;
      } else {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }
    if (!userId) userId = await resolveMyUserId();
  } else {
    userId = await resolveMyUserId();
  }

  if (!userId) {
    return NextResponse.json({ userId: null, displayName: null, metrics: null, priorMetrics: null, trends: null, sessions: [], modelMix: [], journeyGrid: [], githubRepos: null });
  }

  const now = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = now - 7 * 24 * 3600;
  const thirtyDaysAgo = now - 30 * 24 * 3600;

  // Per-user GitHub repos: 35d window rows scoped to
  // currently-mapped repos. null = no window rows at all ("Not captured"
  // rendering); count7d: 0 = window rows exist but none in the last 7 days.
  let githubRepos: { count7d: number; names7d: string[] } | null = null;
  if (userId) {
    const grm = schema.githubRepoMap;
    const gurs = schema.githubUserRepoStats;
    const mappedRepoRows = await client.select({ repo: grm.repo }).from(grm);
    const mappedRepos = mappedRepoRows.map(r => r.repo);
    if (mappedRepos.length > 0) {
      const since35 = new Date((now - 35 * 24 * 3600) * 1000).toISOString().slice(0, 10);
      const since7 = new Date((now - 7 * 24 * 3600) * 1000).toISOString().slice(0, 10);
      const rows = await client
        .select({ repo: gurs.repo, date: gurs.date, c: gurs.commit_count })
        .from(gurs)
        .where(and(eq(gurs.user_id, userId), gte(gurs.date, since35), inArray(gurs.repo, mappedRepos)));
      if (rows.length > 0) {
        const repos7 = [...new Set(rows.filter(r => r.date >= since7 && Number(r.c) > 0).map(r => r.repo))].sort();
        githubRepos = { count7d: repos7.length, names7d: repos7.slice(0, 3) };
      }
    }
  }

  const metricsRows = await client
    .select({
      spend_usd: cm.spend_usd, input_tokens: cm.input_tokens, output_tokens: cm.output_tokens,
      cache_hit_ratio: cm.cache_hit_ratio, autonomy_ratio: cm.autonomy_ratio, session_count: cm.session_count,
      repo_count: cm.repo_count, commit_count: cm.commit_count, skill_leverage: cm.skill_leverage,
      friction_index: cm.friction_index, active_time_user_s: cm.active_time_user_s, active_time_cli_s: cm.active_time_cli_s,
      lines_added: cm.lines_added, lines_removed: cm.lines_removed, pr_count: cm.pr_count,
      edit_accept_count: cm.edit_accept_count, edit_reject_count: cm.edit_reject_count,
      period_start: cm.period_start, period_end: cm.period_end, computed_at: cm.computed_at,
    })
    .from(cm)
    .where(and(eq(cm.scope_type, 'user'), eq(cm.scope_id, userId), eq(cm.granularity, 'rolling')))
    .orderBy(desc(cm.computed_at))
    .limit(1);
  const metricsRaw = metricsRows[0] ?? null;
  const metrics = metricsRaw
    ? { ...metricsRaw, spend_usd: metricsRaw.spend_usd !== null ? Number(metricsRaw.spend_usd) : null }
    : null;

  const priorMetricsRows = await client
    .select({
      spend_usd: cm.spend_usd, autonomy_ratio: cm.autonomy_ratio, cache_hit_ratio: cm.cache_hit_ratio,
      session_count: cm.session_count, repo_count: cm.repo_count,
    })
    .from(cm)
    .where(and(
      eq(cm.scope_type, 'user'), eq(cm.scope_id, userId), eq(cm.granularity, 'rolling'),
      sql`${cm.computed_at} <= ${sevenDaysAgo}`,
    ))
    .orderBy(desc(cm.computed_at))
    .limit(1);
  const priorMetricsRaw = priorMetricsRows[0] ?? null;
  const priorMetrics = priorMetricsRaw
    ? { ...priorMetricsRaw, spend_usd: priorMetricsRaw.spend_usd !== null ? Number(priorMetricsRaw.spend_usd) : null }
    : null;

  // Recent sessions with per-session spend (priced from the per-model rollup).
  // The correlated-subquery "source" lookup is kept as a raw expression — the
  // simplest option for a scalar-subquery column.
  const rates = await getCodeModelRates();
  const rawSessions = await client
    .select({
      session_id: css.session_id, repo: css.repo, git_branch: css.git_branch,
      first_at: css.first_at, last_at: css.last_at,
      user_msg_count: css.user_msg_count, assistant_turns: css.assistant_turns, tool_use_count: css.tool_use_count,
      input_tokens: css.input_tokens, output_tokens: css.output_tokens, cache_read_tokens: css.cache_read_tokens,
      models_json: css.models_json,
      // Correlated scalar subquery — kept as a raw literal-table-name
      // expression (mirrors lib/pulse/code/aggregator.ts's dirty-sessions
      // UNION) rather than embedding the `cam` table object in `sql`, which
      // Drizzle does not guarantee renders to a bare identifier.
      source: sql<string>`COALESCE(
        (SELECT source FROM code_assistant_meta WHERE session_id = ${css.session_id} AND model != '' LIMIT 1),
        'agent'
      )`,
    })
    .from(css)
    .where(eq(css.user_id, userId))
    .orderBy(desc(css.last_at))
    .limit(20);

  const sessions = rawSessions.map(s => {
    let spendUsd: number | null = null;
    if (s.models_json) {
      try {
        const models = JSON.parse(s.models_json) as Record<string, { input: number; output: number; cache_creation: number; cache_read: number }>;
        let sum = 0; let any = false;
        for (const [model, u2] of Object.entries(models)) {
          const usd = priceTokens(model, {
            inputTokens: u2.input, outputTokens: u2.output,
            cacheCreationTokens: u2.cache_creation, cacheReadTokens: u2.cache_read,
          }, rates);
          if (usd !== null) { sum += usd; any = true; }
        }
        spendUsd = any ? sum : null;
      } catch { /* leave null */ }
    }
    const rest: Record<string, unknown> = { ...s };
    delete rest.models_json;
    return { ...rest, spend_usd: spendUsd };
  });

  const modelMixRaw = await client
    .select({
      model: cam.model,
      input_tokens: sql<number | string>`SUM(${cam.input_tokens})`,
      output_tokens: sql<number | string>`SUM(${cam.output_tokens})`,
      cache_creation_tokens: sql<number | string>`SUM(${cam.cache_creation_tokens})`,
      cache_read_tokens: sql<number | string>`SUM(${cam.cache_read_tokens})`,
      // Turns are PROMPTS: a prompt stores one row per model call.
      turns: sql<number | string>`COUNT(DISTINCT COALESCE(${cam.prompt_id}, ${cam.id}))`,
    })
    .from(cam)
    .where(and(eq(cam.user_id, userId), gte(cam.occurred_at, thirtyDaysAgo), sql`${cam.model} != ''`))
    .groupBy(cam.model)
    .orderBy(desc(sql`SUM(${cam.input_tokens}) + SUM(${cam.output_tokens})`));
  const modelMix = modelMixRaw.map(m => ({
    model: m.model,
    input_tokens: Number(m.input_tokens),
    output_tokens: Number(m.output_tokens),
    cache_creation_tokens: Number(m.cache_creation_tokens),
    cache_read_tokens: Number(m.cache_read_tokens),
    turns: Number(m.turns),
  }));

  // Journey grid (judged layer): weekly session-tier counts over 6 weeks.
  // Bucketed by when the work HAPPENED (session last_at), not when classified.
  const sixWeeksAgo = now - 42 * 24 * 3600;
  const tierRows = await client
    .select({ tier: csc.tier, provisional: csc.provisional, last_at: css.last_at })
    .from(csc)
    .innerJoin(css, eq(css.session_id, csc.session_id))
    .where(and(eq(csc.user_id, userId), eq(csc.status, 'classified'), gte(css.last_at, sixWeeksAgo)));

  const journeyCounts = new Map<string, number>();
  const journeyProvisional = new Map<string, number>();
  for (const r of tierRows) {
    // Match the Cowork journey convention (commit c710a56): Wk 1 = most recent week,
    // Wk 6 = oldest. Previously Code anchored Wk 1 at the oldest week, so a recent
    // user's activity showed up at "Wk 6" instead of "Wk 1".
    const week = Math.min(5, Math.floor((now - r.last_at) / (7 * 24 * 3600)));
    const key = `${week}-${r.tier}`;
    journeyCounts.set(key, (journeyCounts.get(key) ?? 0) + 1);
    if (r.provisional) journeyProvisional.set(key, (journeyProvisional.get(key) ?? 0) + 1);
  }
  const journeyGrid = [...journeyCounts.entries()].map(([key, count]) => {
    const [week, tier] = key.split('-').map(Number);
    return { week, tier, count, provisionalCount: journeyProvisional.get(key) ?? 0 };
  });

  const nameRows = await client
    .select({ display_name: u.display_name, email: u.email })
    .from(u)
    .where(eq(u.id, userId))
    .limit(1);
  const nameRow = nameRows[0];
  const displayName = nameRow?.display_name ?? nameRow?.email ?? null;

  // Personal 8-week sparklines — Engaged Time and Code Output, user scope.
  const personalTrend = async (column: 'active_time_user_s' | 'lines_added') => ({
    series: await getWeeklySeries('code_metrics', 'user', userId!, column, 8),
    delta: await getWeeklyDelta('code_metrics', 'user', userId!, column, 8),
  });
  const trends = {
    engagedTime: await personalTrend('active_time_user_s'),
    codeOutput: await personalTrend('lines_added'),
  };

  // Person-level human time: admins and managers for anyone, everyone else for themselves only.
  const seesPerson = session.role === 'admin' || session.role === 'manager' || userId === (await resolveMyUserId());
  const humanTime = seesPerson ? await readHumanTime('code', [userId]) : null;
  // Link to this person's Spend Review, for whoever may open it
  // (lib/finance/spend-review-access.ts); it lives under FinOps and is hidden with it.
  const canSeeSpendReview = (await getAllConfig()).chargebackEnabled === true
    && await canViewSpendReview(session, userId);
  return NextResponse.json({ userId, displayName, metrics, priorMetrics, trends, sessions, modelMix, journeyGrid, githubRepos, humanTime, canSeeSpendReview });
}
