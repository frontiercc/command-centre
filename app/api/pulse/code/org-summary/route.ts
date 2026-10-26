// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern (lib/pulse/code/aggregator.ts, the
// route app/api/pulse/cio/route.ts): getTypedClient() + schema.<table>, the
// query builder for GROUP BY/HAVING aggregates, and a raw sql`CAST(... AS
// REAL)` expression for the friction ratio (matching
// lib/alerts/code-pulse-alerts.ts's checkFriction()). Every SUM/COUNT aggregate is Number()-coerced (bigint/numeric come back as STRINGS on Postgres); `code_metrics.spend_usd`
// is `numeric` on pg specifically, so its single-row reads are also coerced.
import { getCodeWorkTypeDefinitions } from '@/lib/pulse/code/tier-config';
import { codeWorkTypeLabel, codeWorkTypeDefinition } from '@/lib/pulse/code/work-type-labels';
import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, gte, inArray, isNotNull, lte, ne, notInArray, sql } from 'drizzle-orm';
import { getAdminSession, canAccessOrgOverview } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue } from '@/lib/config';
import { getCodeModelRates, priceTokens, spendIsPartlyEstimated, isEstimatedPricing } from '@/lib/pulse/code/rates';
import { ORG_SCOPE_ID } from '@/lib/pulse/code/aggregator';
import { computeSpendConcentration } from '@/lib/pulse/code/concentration';
import { getWeeklySeries, getWeeklyDelta } from '@/lib/pulse/trends';
import { projectMonthEndSpend, type SpendProjection } from '@/lib/pulse/code/projection';
import { buildDailyWindow, buildShippingSeries, buildRepoCards, countReposActive7d, type GhDailyRow, type ShippingDay, type RepoShippingCard } from '@/lib/pulse/code/shipping-alignment';
import { readHumanTime } from '@/lib/pulse/human-time-summary';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessOrgOverview(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const client = await getTypedClient();
  const now = Math.floor(Date.now() / 1000);
  const thirtyDaysAgo = now - 30 * 24 * 3600;
  const sevenDaysAgo = now - 7 * 24 * 3600;

  const cm = schema.codeMetrics;
  const cam = schema.codeAssistantMeta;
  const css = schema.codeSessionStats;
  const csi = schema.coworkSkillInvocations;
  const cmi = schema.coworkMcpInvocations;
  const com = schema.codeOtelMetrics;
  const grm = schema.githubRepoMap;
  const grs = schema.githubRepoStats;
  const csc = schema.codeSessionClassifications;
  const usr = schema.users;
  const adu = schema.adminUsers;

  const metricsCols = {
    spend_usd: cm.spend_usd,
    input_tokens: cm.input_tokens,
    output_tokens: cm.output_tokens,
    cache_hit_ratio: cm.cache_hit_ratio,
    autonomy_ratio: cm.autonomy_ratio,
    session_count: cm.session_count,
    repo_count: cm.repo_count,
    commit_count: cm.commit_count,
    skill_leverage: cm.skill_leverage,
    friction_index: cm.friction_index,
    active_time_user_s: cm.active_time_user_s,
    active_time_cli_s: cm.active_time_cli_s,
    lines_added: cm.lines_added,
    lines_removed: cm.lines_removed,
    pr_count: cm.pr_count,
    edit_accept_count: cm.edit_accept_count,
    edit_reject_count: cm.edit_reject_count,
    period_start: cm.period_start,
    period_end: cm.period_end,
    computed_at: cm.computed_at,
  };

  const metricsRows = await client
    .select(metricsCols)
    .from(cm)
    .where(and(eq(cm.scope_type, 'organisation'), eq(cm.scope_id, ORG_SCOPE_ID), eq(cm.granularity, 'rolling')))
    .orderBy(desc(cm.computed_at))
    .limit(1);
  const metricsRaw = metricsRows[0] ?? null;
  const metrics = metricsRaw
    ? { ...metricsRaw, spend_usd: metricsRaw.spend_usd !== null ? Number(metricsRaw.spend_usd) : null }
    : null;

  const priorMetricsRows = await client
    .select({
      spend_usd: cm.spend_usd,
      autonomy_ratio: cm.autonomy_ratio,
      cache_hit_ratio: cm.cache_hit_ratio,
      session_count: cm.session_count,
      repo_count: cm.repo_count,
    })
    .from(cm)
    .where(and(
      eq(cm.scope_type, 'organisation'), eq(cm.scope_id, ORG_SCOPE_ID), eq(cm.granularity, 'rolling'),
      lte(cm.computed_at, sevenDaysAgo),
    ))
    .orderBy(desc(cm.computed_at))
    .limit(1);
  const priorMetricsRaw = priorMetricsRows[0] ?? null;
  const priorMetrics = priorMetricsRaw
    ? { ...priorMetricsRaw, spend_usd: priorMetricsRaw.spend_usd !== null ? Number(priorMetricsRaw.spend_usd) : null }
    : null;

  // Token share by model, last 30 days
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
    .where(and(gte(cam.occurred_at, thirtyDaysAgo), ne(cam.model, '')))
    .groupBy(cam.model)
    .orderBy(desc(sql`SUM(${cam.input_tokens}) + SUM(${cam.output_tokens})`));
  const modelMix = modelMixRaw.map(m => ({
    model: m.model as string,
    input_tokens: Number(m.input_tokens),
    output_tokens: Number(m.output_tokens),
    cache_creation_tokens: Number(m.cache_creation_tokens),
    cache_read_tokens: Number(m.cache_read_tokens),
    turns: Number(m.turns),
  }));

  const rates = await getCodeModelRates();
  // Unpriced = no exact rate AND no normalised fallback. A Bedrock/Vertex id priced at the
  // canonical list rate is an estimate (the badge below), not unpriced (same rule as health.ts).
  const unpricedModels = modelMix.map(m => m.model).filter(m => !rates[m] && !isEstimatedPricing(m, rates));

  // True when spend in this window includes at least one Bedrock/Vertex
  // model priced only via the normalised-key fallback (Anthropic list rate,
  // an estimate — see rates.ts normalizeModelId). Drives the violet
  // "includes provider-routed usage estimated at list pricing" badge on the
  // spend tile.
  const spendIsPartlyEstimatedFlag = spendIsPartlyEstimated(modelMix.map(m => m.model), rates);

  // Active repos (30d) and dark repos (seen before, silent in window)
  const activeReposRaw = await client
    .select({
      repo: css.repo,
      sessions: sql<number | string>`COUNT(*)`,
      tokens: sql<number | string>`SUM(${css.input_tokens} + ${css.output_tokens})`,
      commits: sql<number | string>`SUM(${css.commit_count})`,
    })
    .from(css)
    .where(and(isNotNull(css.repo), gte(css.last_at, thirtyDaysAgo)))
    .groupBy(css.repo)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(20);
  const activeRepos = activeReposRaw.map(r => ({
    repo: r.repo, sessions: Number(r.sessions), tokens: Number(r.tokens), commits: Number(r.commits),
  }));

  const darkReposRaw = await client
    .select({ repo: css.repo, last_seen: sql<number | string>`MAX(${css.last_at})` })
    .from(css)
    .where(isNotNull(css.repo))
    .groupBy(css.repo)
    .having(sql`MAX(${css.last_at}) < ${thirtyDaysAgo}`)
    .orderBy(desc(sql`MAX(${css.last_at})`))
    .limit(20);
  const darkRepos = darkReposRaw.map(r => ({ repo: r.repo, last_seen: Number(r.last_seen) }));

  // Top skills and connectors used in code-surface sessions, 30d
  const topSkillsRaw = await client
    .select({
      skill_name: csi.skill_name,
      uses: sql<number | string>`COUNT(*)`,
      agent_chained: sql<number | string>`SUM(CASE WHEN ${csi.invocation_type} = 'agent_chained' THEN 1 ELSE 0 END)`,
    })
    .from(csi)
    .innerJoin(css, eq(css.session_id, csi.session_id))
    .where(gte(csi.occurred_at, thirtyDaysAgo))
    .groupBy(csi.skill_name)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(10);
  const topSkills = topSkillsRaw.map(r => ({
    skill_name: r.skill_name, uses: Number(r.uses), agent_chained: Number(r.agent_chained),
  }));

  const topConnectorsRaw = await client
    .select({ mcp_server: cmi.mcp_server, uses: sql<number | string>`COUNT(*)` })
    .from(cmi)
    .innerJoin(css, eq(css.session_id, cmi.session_id))
    .where(and(gte(cmi.occurred_at, thirtyDaysAgo), notInArray(cmi.mcp_server, ['workspace', 'cowork'])))
    .groupBy(cmi.mcp_server)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(10);
  const topConnectors = topConnectorsRaw.map(r => ({ mcp_server: r.mcp_server, uses: Number(r.uses) }));

  // Leverage: spend + output attributed to the active skill / subagent,
  // priced with the same model rates as total spend. Source: the api_request
  // enrichment columns (migration 051). Unpriced models contribute turns but null spend.
  const leverageBy = async (column: 'skill_name' | 'agent_name') => {
    const col = cam[column];
    const grouped = await client
      .select({
        name: col,
        model: cam.model,
        inp: sql<number | string>`SUM(${cam.input_tokens})`,
        outp: sql<number | string>`SUM(${cam.output_tokens})`,
        cw: sql<number | string>`SUM(${cam.cache_creation_tokens})`,
        cr: sql<number | string>`SUM(${cam.cache_read_tokens})`,
        // Turns are PROMPTS: a prompt stores one row per model call.
        turns: sql<number | string>`COUNT(DISTINCT COALESCE(${cam.prompt_id}, ${cam.id}))`,
      })
      .from(cam)
      .where(and(isNotNull(col), ne(col, ''), gte(cam.occurred_at, thirtyDaysAgo), ne(cam.model, '')))
      .groupBy(col, cam.model);
    const byName = new Map<string, { name: string; turns: number; tokens: number; spend: number; anyPriced: boolean }>();
    for (const r of grouped) {
      const name = r.name as string;
      const inp = Number(r.inp);
      const outp = Number(r.outp);
      const cw = Number(r.cw);
      const cr = Number(r.cr);
      const turns = Number(r.turns);
      const e = byName.get(name) ?? { name, turns: 0, tokens: 0, spend: 0, anyPriced: false };
      e.turns += turns;
      e.tokens += inp + outp + cw + cr;
      const usd = priceTokens(r.model as string, { inputTokens: inp, outputTokens: outp, cacheCreationTokens: cw, cacheReadTokens: cr }, rates);
      if (usd !== null) { e.spend += usd; e.anyPriced = true; }
      byName.set(name, e);
    }
    return [...byName.values()]
      .map(e => ({ name: e.name, turns: e.turns, tokens: e.tokens, spend_usd: e.anyPriced ? e.spend : null }))
      .sort((a, b) => (b.spend_usd ?? 0) - (a.spend_usd ?? 0) || b.turns - a.turns)
      .slice(0, 10);
  };
  const skillLeverage = await leverageBy('skill_name');
  const agentLeverage = await leverageBy('agent_name');

  // Autonomy: share of turns driven by a named subagent (delegation depth).
  const autonomyRows = await client
    .select({
      subagent: sql<number | string | null>`SUM(CASE WHEN ${cam.agent_name} IS NOT NULL AND ${cam.agent_name} != '' THEN 1 ELSE 0 END)`,
      total: sql<number | string | null>`COUNT(*)`,
    })
    .from(cam)
    .where(and(gte(cam.occurred_at, thirtyDaysAgo), ne(cam.model, '')));
  const autonomyRow = autonomyRows[0];
  const autonomyTotal = Number(autonomyRow?.total ?? 0);
  const subagentShare = autonomyTotal ? Number(autonomyRow?.subagent ?? 0) / autonomyTotal : null;

  // Spend concentration (30d): how much of total priced spend comes from the top
  // few users. Priced per-user from the same token rates as everything else —
  // measured, not estimated. Hidden below a minimum spender count (see helper).
  const perUserSpendRows = await client
    .select({
      user_id: cam.user_id,
      model: cam.model,
      inp: sql<number | string>`SUM(${cam.input_tokens})`,
      outp: sql<number | string>`SUM(${cam.output_tokens})`,
      cw: sql<number | string>`SUM(${cam.cache_creation_tokens})`,
      cr: sql<number | string>`SUM(${cam.cache_read_tokens})`,
    })
    .from(cam)
    .where(and(isNotNull(cam.user_id), ne(cam.user_id, ''), gte(cam.occurred_at, thirtyDaysAgo), ne(cam.model, '')))
    .groupBy(cam.user_id, cam.model);
  const spendByUser = new Map<string, number>();
  for (const r of perUserSpendRows) {
    const usd = priceTokens(r.model as string, {
      inputTokens: Number(r.inp), outputTokens: Number(r.outp), cacheCreationTokens: Number(r.cw), cacheReadTokens: Number(r.cr),
    }, rates);
    if (usd !== null) spendByUser.set(r.user_id as string, (spendByUser.get(r.user_id as string) ?? 0) + usd);
  }
  const spendConcentration = computeSpendConcentration([...spendByUser.values()]);

  // Month-end spend projection: month-to-date priced spend (UTC calendar
  // month) plus the last-7-day priced run rate extended to month end. Same
  // pricing path as everything else — unpriced models contribute nothing to
  // either sum (null-never-zero), never presented as measured (see the
  // violet estimate badge on the UI side).
  const monthStart = Math.floor(Date.UTC(
    new Date(now * 1000).getUTCFullYear(),
    new Date(now * 1000).getUTCMonth(),
    1
  ) / 1000);

  async function sumPricedSpend(sinceEpochS: number): Promise<number> {
    const rows = await client
      .select({
        model: cam.model,
        inp: sql<number | string>`SUM(${cam.input_tokens})`,
        outp: sql<number | string>`SUM(${cam.output_tokens})`,
        cw: sql<number | string>`SUM(${cam.cache_creation_tokens})`,
        cr: sql<number | string>`SUM(${cam.cache_read_tokens})`,
      })
      .from(cam)
      .where(and(gte(cam.occurred_at, sinceEpochS), ne(cam.model, '')))
      .groupBy(cam.model);
    let total = 0;
    for (const r of rows) {
      const usd = priceTokens(r.model as string, {
        inputTokens: Number(r.inp), outputTokens: Number(r.outp), cacheCreationTokens: Number(r.cw), cacheReadTokens: Number(r.cr),
      }, rates);
      if (usd !== null) total += usd;
    }
    return total;
  }

  const mtdSpend = await sumPricedSpend(monthStart);
  const last7dSpend = await sumPricedSpend(sevenDaysAgo);
  const spendProjection: SpendProjection | null = last7dSpend > 0
    ? projectMonthEndSpend(mtdSpend, last7dSpend, now)
    : null;

  // Language Mix: edit-decision counts by language (from the OTel metrics stream).
  // The repo-free "what are people working on" axis.
  const languageMixRaw = await client
    .select({ language: com.language, edits: sql<number | string>`SUM(${com.value})` })
    .from(com)
    .where(and(
      eq(com.metric_name, 'claude_code.code_edit_tool.decision'),
      isNotNull(com.language), ne(com.language, ''),
      gte(com.occurred_at, thirtyDaysAgo),
    ))
    .groupBy(com.language)
    .orderBy(desc(sql`SUM(${com.value})`))
    .limit(8);
  const languageMix = languageMixRaw.map(r => ({ language: r.language as string, edits: Number(r.edits) }));

  // GitHub overlay — GitHub shipping VOLUME for the manually-tracked repos.
  // Repo/org level only (never commits/authors). No in-session share: Claude Code
  // OTel has no cwd, so commits can't be attributed to sessions. This is shipping
  // context for the tracked repos, read alongside the OTel commit/PR metrics.
  const mappedRepoRows = await client.select({ repo: grm.repo }).from(grm);
  const mappedRepos = mappedRepoRows.map(r => r.repo);
  const sevenDayDate = new Date((now - 7 * 24 * 3600) * 1000).toISOString().slice(0, 10);
  const thirtyDayDate = new Date(thirtyDaysAgo * 1000).toISOString().slice(0, 10);

  let githubOverlay: {
    trackedRepoCount: number;
    totalCommits7d: number;
    totalPrs7d: number;
    totalCommits30dByRepo: Record<string, number>;
    reposActive7d: number;
    shippingSeries: ShippingDay[];
    repoCards: RepoShippingCard[];
  } | null = null;

  if (mappedRepos.length > 0) {
    // Covered = tracked repos that actually have synced stats (a repo whose sync
    // fails — wrong name, private without token — must not count). Scoped to
    // mappedRepos so a since-untracked repo's stale github_repo_stats rows
    // (nothing deletes them on untrack) never resurface as a phantom card.
    const coveredRepoRows = await client.selectDistinct({ repo: grs.repo }).from(grs).where(inArray(grs.repo, mappedRepos));
    const coveredRepos = coveredRepoRows.map(r => r.repo);

    if (coveredRepos.length > 0) {
      const vol7Rows = await client
        .select({
          commits: sql<number | string>`COALESCE(SUM(${grs.commit_count}), 0)`,
          prs: sql<number | string>`COALESCE(SUM(${grs.prs_merged}), 0)`,
        })
        .from(grs)
        .where(gte(grs.date, sevenDayDate));
      const vol7 = vol7Rows[0];
      const perRepo30Rows = await client
        .select({ repo: grs.repo, c: sql<number | string>`SUM(${grs.commit_count})` })
        .from(grs)
        .where(gte(grs.date, thirtyDayDate))
        .groupBy(grs.repo);

      // Shipping alignment series/cards need day-grain rows over the exact
      // 30-entry window buildDailyWindow produces (today back 29 days
      // inclusive). thirtyDayDate above (today - 30 days) is one day earlier
      // than that window's first day — filtering ghDailyRows on it would let
      // a boundary-day row (dated windowDays[0] minus 1) through even though
      // no day in the window maps to it, surfacing a phantom all-zero repo
      // card. Compute windowDays first and filter on its first entry instead.
      const windowDays = buildDailyWindow(new Date(now * 1000).toISOString().slice(0, 10), 30);

      // Day-grain AI-assisted commits — same rows the aggregator sums into
      // code_metrics.commit_count, re-bucketed by UTC day for the alignment
      // series. UTC day expression (idiom: lib/pulse/stickiness.ts).
      const dayExpr = sql<string>`to_char(to_timestamp(${cam.occurred_at}) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
      const aiDailyRows = await client
        .select({ day: dayExpr, commits: sql<number | string>`SUM(${cam.commit_count})` })
        .from(cam)
        .where(gte(cam.occurred_at, thirtyDaysAgo))
        .groupBy(sql`1`);
      const aiByDay: Record<string, number> = {};
      for (const r of aiDailyRows) aiByDay[r.day] = Number(r.commits ?? 0);

      const ghDailyRows: GhDailyRow[] = (await client
        .select({ repo: grs.repo, date: grs.date, commit_count: grs.commit_count, prs_merged: grs.prs_merged })
        .from(grs)
        .where(and(gte(grs.date, windowDays[0]), inArray(grs.repo, mappedRepos))))
        .map(r => ({ repo: r.repo, date: r.date, commit_count: Number(r.commit_count), prs_merged: Number(r.prs_merged) }));

      githubOverlay = {
        trackedRepoCount: coveredRepos.length,
        totalCommits7d: Number(vol7?.commits ?? 0),
        totalPrs7d: Number(vol7?.prs ?? 0),
        totalCommits30dByRepo: Object.fromEntries(perRepo30Rows.map(r => [r.repo, Number(r.c)])),
        reposActive7d: countReposActive7d(windowDays, ghDailyRows),
        shippingSeries: buildShippingSeries(windowDays, aiByDay, ghDailyRows),
        repoCards: buildRepoCards(windowDays, ghDailyRows),
      };
    }
  }

  // Sessions where a meaningful share of tool actions failed — coaching list.
  // CAST(... AS REAL) (matches lib/alerts/code-pulse-alerts.ts's checkFriction()).
  // user_display_name: Claude Code's OTel stream sends user.id as a 64-char hash,
  // and `repo` is always null on an OTel-only deployment (no cwd in the stream),
  // so without this join the card renders a bare hash as its only label. Same
  // COALESCE(admin_users, users) resolution the Alerts page uses; additive —
  // user_id is still returned.
  const highFrictionSessions = await client
    .select({
      session_id: css.session_id, user_id: css.user_id, repo: css.repo,
      error_count: css.error_count, tool_use_count: css.tool_use_count, last_at: css.last_at,
      user_display_name: sql<string | null>`COALESCE(${adu.display_name}, ${usr.display_name}, ${usr.email})`,
    })
    .from(css)
    .leftJoin(usr, eq(usr.id, css.user_id))
    .leftJoin(adu, eq(adu.linked_cowork_user_id, css.user_id))
    .where(and(
      gte(css.last_at, sevenDaysAgo),
      gte(css.tool_use_count, 5),
      sql`CAST(${css.error_count} AS REAL) / ${css.tool_use_count} > 0.25`,
    ))
    .orderBy(desc(sql`CAST(${css.error_count} AS REAL) / ${css.tool_use_count}`))
    .limit(10);

  // Judged layer (opt-in): work-type mix from the session-digest classifier.
  // null = classifier disabled; [] = enabled but nothing classified yet.
  const judgedLayerEnabled = (await getConfigValue('codeClassifierEnabled')) !== 'false';
  let workMix: Array<{ work_type: string; label: string; definition: string | null; sessions: number; tier3: number; tier2: number; tier1: number; provisional: number }> | null = null;
  if (judgedLayerEnabled) {
    const workMixRaw = await client
      .select({
        work_type: csc.work_type,
        sessions: sql<number | string>`COUNT(*)`,
        tier3: sql<number | string>`SUM(CASE WHEN ${csc.tier} = 3 THEN 1 ELSE 0 END)`,
        tier2: sql<number | string>`SUM(CASE WHEN ${csc.tier} = 2 THEN 1 ELSE 0 END)`,
        tier1: sql<number | string>`SUM(CASE WHEN ${csc.tier} = 1 THEN 1 ELSE 0 END)`,
        provisional: sql<number | string>`SUM(CASE WHEN ${csc.provisional} = 1 THEN 1 ELSE 0 END)`,
      })
      .from(csc)
      .innerJoin(css, eq(css.session_id, csc.session_id))
      .where(and(eq(csc.status, 'classified'), gte(css.last_at, thirtyDaysAgo)))
      .groupBy(csc.work_type)
      .orderBy(desc(sql`COUNT(*)`));
    const defs = await getCodeWorkTypeDefinitions();
    workMix = workMixRaw.map(r => ({
      work_type: r.work_type,
      label: codeWorkTypeLabel(r.work_type, defs.get(r.work_type)),
      definition: codeWorkTypeDefinition(r.work_type, defs.get(r.work_type)),
      sessions: Number(r.sessions), tier3: Number(r.tier3), tier2: Number(r.tier2), tier1: Number(r.tier1),
      provisional: Number(r.provisional),
    }));
  }

  // 8-week calendar-aligned trends for the verdict cards, org scope. The
  // current (partial) week is included and flagged — never presented as a
  // completed week. Deltas compare the two most recent COMPLETED weeks.
  const trendSeries = async (column: 'spend_usd' | 'autonomy_ratio' | 'commit_count' | 'session_count') => ({
    series: await getWeeklySeries('code_metrics', 'organisation', ORG_SCOPE_ID, column, 8),
    delta: await getWeeklyDelta('code_metrics', 'organisation', ORG_SCOPE_ID, column, 8),
  });
  const trends = {
    spend: await trendSeries('spend_usd'),
    autonomy: await trendSeries('autonomy_ratio'),
    commits: await trendSeries('commit_count'),
    sessions: await trendSeries('session_count'),
  };

  // Human time vs Claude time — org totals; null when off.
  const humanTime = await readHumanTime('code');

  return NextResponse.json({
    humanTime,
    metrics,
    priorMetrics,
    trends,
    modelMix,
    unpricedModels,
    spendIsPartlyEstimated: spendIsPartlyEstimatedFlag,
    activeRepos,
    darkRepos,
    topSkills,
    topConnectors,
    skillLeverage,
    agentLeverage,
    subagentShare,
    spendConcentration,
    languageMix,
    highFrictionSessions,
    workMix,
    githubOverlay,
    spendProjection,
  });
}
