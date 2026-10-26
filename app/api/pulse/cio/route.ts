// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table> +
// query-builder groupBy/orderBy for most aggregates, and a local rawAll()
// facade for the one date-bucket read (month
// bucketing via to_char AT TIME ZONE 'UTC', mirroring lib/db/
// queries.ts + lib/pulse/stickiness.ts). Every raw-SQL COUNT/SUM/AVG
// aggregate is Number()-coerced (bigint/numeric come back as
// STRINGS on Postgres).
import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { getAdminSession, canAccessOrgOverview } from '@/lib/auth/admin-auth';
import { promptTextVisibleFor, logPromptRead } from '@/lib/auth/content-access';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { weekStart, weekStarts } from '@/lib/pulse/period';
import { assertPulseMetricsColumn } from '@/lib/pulse/trends';
import { getFileCategoryMix } from '@/lib/pulse/cowork/file-categories';
import {
  buildBandSegments, buildDepthSegments, buildThenVsNow,
  countDataWeeks, countLatestSegmentDataWeeks, MIN_CHART_DATA_WEEKS,
  type DelegationWeekRow,
} from '@/lib/pulse/delegation';
import { buildActNext, buildDeptProcessBoxes, type ActNextRow } from '@/lib/pulse/act-next';
import type { DeptProcessBox } from '@/lib/usecases/suggestion-store';

export const dynamic = 'force-dynamic';

// ─── Raw-execution facade (mirrors lib/db/queries.ts's rawAll) ────────────────
interface RawFacade {
  execute?: (q: unknown) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}
async function rawAll<T>(client: unknown, query: unknown): Promise<T[]> {
  const c = client as RawFacade;
  const res = await c.execute!(query);
  return res.rows as T[];
}

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated || !canAccessOrgOverview(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const client = await getTypedClient();
  const now = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = now - 7 * 24 * 3600;
  const fourteenDaysAgo = now - 14 * 24 * 3600;
  const thirtyDaysAgo = now - 30 * 24 * 3600;
  const sixtyDaysAgo = now - 60 * 24 * 3600;

  const pc = schema.pulseClassifications;
  const pm = schema.pulseMetrics;
  const pe = schema.pulseEvents;

  // ── Adoption hero numbers (current 30-day window) ─────────────────────────

  // People using Cowork weekly (distinct user_ids with at least one classification this week)
  const weeklyActiveRows = await client
    .select({ cnt: sql<number | string>`COUNT(DISTINCT ${pc.user_id})` })
    .from(pc)
    .where(and(gte(pc.classified_at, sevenDaysAgo), eq(pc.classifier_status, 'classified')));
  const weeklyActive = Number(weeklyActiveRows[0]?.cnt ?? 0);

  // Prior period weekly active (week before last)
  const priorWeekStart = now - 14 * 24 * 3600;
  const priorWeekActiveRows = await client
    .select({ cnt: sql<number | string>`COUNT(DISTINCT ${pc.user_id})` })
    .from(pc)
    .where(and(gte(pc.classified_at, priorWeekStart), lt(pc.classified_at, sevenDaysAgo), eq(pc.classifier_status, 'classified')));
  const priorWeeklyActive = Number(priorWeekActiveRows[0]?.cnt ?? 0);

  // Total active users in past 14 days
  const totalActiveRows = await client
    .select({ cnt: sql<number | string>`COUNT(DISTINCT ${pc.user_id})` })
    .from(pc)
    .where(and(gte(pc.classified_at, fourteenDaysAgo), eq(pc.classifier_status, 'classified')));
  const totalActive = Number(totalActiveRows[0]?.cnt ?? 0);

  // % of time on Tier 2+ (current 30 days)
  const tierBreakdown = await client
    .select({ tier: pc.tier, cnt: sql<number | string>`COUNT(*)` })
    .from(pc)
    .where(and(gte(pc.classified_at, thirtyDaysAgo), eq(pc.classifier_status, 'classified')))
    .groupBy(pc.tier);

  const tierCounts = { 1: 0, 2: 0, 3: 0 };
  for (const row of tierBreakdown) {
    if (row.tier === 1 || row.tier === 2 || row.tier === 3) tierCounts[row.tier] = Number(row.cnt);
  }
  const totalTier = tierCounts[1] + tierCounts[2] + tierCounts[3];
  const meaningfulWorkPct = totalTier > 0
    ? Math.round(((tierCounts[2] + tierCounts[3]) / totalTier) * 100)
    : 0;

  // % of time on Tier 2+ (prior 30 days: days 31-60)
  const priorTierBreakdown = await client
    .select({ tier: pc.tier, cnt: sql<number | string>`COUNT(*)` })
    .from(pc)
    .where(and(gte(pc.classified_at, sixtyDaysAgo), lt(pc.classified_at, thirtyDaysAgo), eq(pc.classifier_status, 'classified')))
    .groupBy(pc.tier);
  const priorTierCounts = { 1: 0, 2: 0, 3: 0 };
  for (const row of priorTierBreakdown) {
    if (row.tier === 1 || row.tier === 2 || row.tier === 3) priorTierCounts[row.tier] = Number(row.cnt);
  }
  const priorTotalTier = priorTierCounts[1] + priorTierCounts[2] + priorTierCounts[3];
  const priorMeaningfulWorkPct = priorTotalTier > 0
    ? Math.round(((priorTierCounts[2] + priorTierCounts[3]) / priorTotalTier) * 100)
    : null;

  // Average DDS across org
  const avgDdsRows = await client
    .select({ avg_dds: sql<number | string | null>`AVG(${pm.dds})` })
    .from(pm)
    .where(and(eq(pm.scope_type, 'user'), isNotNull(pm.dds), eq(pm.granularity, 'rolling'), gte(pm.computed_at, sevenDaysAgo)));
  const avgDdsRaw = avgDdsRows[0]?.avg_dds;
  const avgDds = avgDdsRaw !== null && avgDdsRaw !== undefined
    ? Math.round(Number(avgDdsRaw) * 100) / 100
    : null;

  // Prior avg DDS
  const priorAvgDdsRows = await client
    .select({ avg_dds: sql<number | string | null>`AVG(${pm.dds})` })
    .from(pm)
    .where(and(eq(pm.scope_type, 'user'), isNotNull(pm.dds), eq(pm.granularity, 'rolling'), gte(pm.computed_at, sixtyDaysAgo), lt(pm.computed_at, sevenDaysAgo)));
  const priorAvgDdsRaw = priorAvgDdsRows[0]?.avg_dds;
  const priorAvgDds = priorAvgDdsRaw !== null && priorAvgDdsRaw !== undefined
    ? Math.round(Number(priorAvgDdsRaw) * 100) / 100 : null;

  // Average OTI across org
  const avgOtiRows = await client
    .select({ avg_oti: sql<number | string | null>`AVG(${pm.oti})` })
    .from(pm)
    .where(and(eq(pm.scope_type, 'user'), isNotNull(pm.oti), eq(pm.granularity, 'rolling'), gte(pm.computed_at, sevenDaysAgo)));
  const avgOtiRaw = avgOtiRows[0]?.avg_oti;
  const avgOti = avgOtiRaw !== null && avgOtiRaw !== undefined
    ? Math.round(Number(avgOtiRaw) * 100) / 100
    : null;

  // Prior avg OTI
  const priorAvgOtiRows = await client
    .select({ avg_oti: sql<number | string | null>`AVG(${pm.oti})` })
    .from(pm)
    .where(and(eq(pm.scope_type, 'user'), isNotNull(pm.oti), eq(pm.granularity, 'rolling'), gte(pm.computed_at, sixtyDaysAgo), lt(pm.computed_at, sevenDaysAgo)));
  const priorAvgOtiRaw = priorAvgOtiRows[0]?.avg_oti;
  const priorAvgOti = priorAvgOtiRaw !== null && priorAvgOtiRaw !== undefined
    ? Math.round(Number(priorAvgOtiRaw) * 100) / 100 : null;

  // Capability concentration risk — % of Tier 3 tasks on top 3 users
  const tier3UserCounts = await client
    .select({ user_id: pc.user_id, cnt: sql<number | string>`COUNT(*)` })
    .from(pc)
    .where(and(eq(pc.tier, 3), eq(pc.classifier_status, 'classified'), gte(pc.classified_at, fourteenDaysAgo)))
    .groupBy(pc.user_id)
    .orderBy(desc(sql`COUNT(*)`));

  const totalTier3 = tier3UserCounts.reduce((s, r) => s + Number(r.cnt), 0);
  const top3Tier3 = tier3UserCounts.slice(0, 3).reduce((s, r) => s + Number(r.cnt), 0);
  const concentrationPct = totalTier3 > 0
    ? Math.round((top3Tier3 / totalTier3) * 100)
    : 0;

  // ── Org-level signal cards ─────────────────────────────────────────────────

  const orgOtiRows = await client
    .select({ v: sql<number | string | null>`AVG(${pm.oti})` })
    .from(pm)
    .where(and(eq(pm.scope_type, 'user'), isNotNull(pm.oti), eq(pm.granularity, 'rolling'), gte(pm.computed_at, sevenDaysAgo)));
  const orgOtiRaw = orgOtiRows[0]?.v;

  const orgDdsRows = await client
    .select({ v: sql<number | string | null>`AVG(${pm.dds})` })
    .from(pm)
    .where(and(eq(pm.scope_type, 'user'), isNotNull(pm.dds), eq(pm.granularity, 'rolling'), gte(pm.computed_at, sevenDaysAgo)));
  const orgDdsRaw = orgDdsRows[0]?.v;

  const orgPsrRows = await client
    .select({ v: sql<number | string>`COUNT(*)` })
    .from(pe)
    .where(and(eq(pe.event_type, 'capability_creation'), eq(pe.status, 'confirmed')));
  const orgPsr = Number(orgPsrRows[0]?.v ?? 0);

  // ORS is only ever computed at group level (scope_type='team' keyed by
  // users.team_id, or scope_type='function' keyed by admin_users.department
  // — see lib/pulse/aggregator.ts). users.team_id is never populated in any
  // real deployment (no admin UI, no ingest default),
  // so 'team' rows never exist; 'function' (department) is the
  // scope that's actually written and populated.
  const orgOrsRows = await client
    .select({ v: sql<number | string | null>`AVG(${pm.ors})` })
    .from(pm)
    .where(and(eq(pm.scope_type, 'function'), isNotNull(pm.ors), eq(pm.granularity, 'rolling'), gte(pm.computed_at, sevenDaysAgo)));
  const orgOrsRaw = orgOrsRows[0]?.v;

  // ORS explainability — average the same three components across
  // departments, consistent with how the composite org ORS above is itself
  // an average of per-department ors.
  const orgOrsComponentsRows = await client
    .select({
      breadth: sql<number | string | null>`AVG(${pm.ors_breadth})`,
      overlap: sql<number | string | null>`AVG(${pm.ors_overlap})`,
      propagation: sql<number | string | null>`AVG(${pm.ors_propagation})`,
    })
    .from(pm)
    .where(and(eq(pm.scope_type, 'function'), isNotNull(pm.ors), eq(pm.granularity, 'rolling'), gte(pm.computed_at, sevenDaysAgo)));
  const orgOrsComponents = orgOrsComponentsRows[0];

  const signalCards = {
    oti: orgOtiRaw !== null && orgOtiRaw !== undefined ? Math.round(Number(orgOtiRaw) * 100) / 100 : null,
    dds: orgDdsRaw !== null && orgDdsRaw !== undefined ? Math.round(Number(orgDdsRaw) * 100) / 100 : null,
    psr: orgPsr,
    ors: orgOrsRaw !== null && orgOrsRaw !== undefined ? Math.round(Number(orgOrsRaw) * 100) / 100 : null,
    orsBreadth: orgOrsComponents?.breadth !== null && orgOrsComponents?.breadth !== undefined ? Math.round(Number(orgOrsComponents.breadth) * 100) / 100 : null,
    orsOverlap: orgOrsComponents?.overlap !== null && orgOrsComponents?.overlap !== undefined ? Math.round(Number(orgOrsComponents.overlap) * 100) / 100 : null,
    orsPropagation: orgOrsComponents?.propagation !== null && orgOrsComponents?.propagation !== undefined ? Math.round(Number(orgOrsComponents.propagation) * 100) / 100 : null,
  };

  // ── Adoption funnel (Priority 6) ─────────────────────────────────────────
  // Group pulse_classifications by user+month for last 6 months.
  // Determine dominant tier per user per month (most frequent tier).
  // Count users per dominant-tier per month.
  const sixMonthsAgo = now - 180 * 24 * 3600;

  // month bucket via to_char(...) AT TIME ZONE 'UTC'
  // — kept as one raw statement since Postgres's strict GROUP BY
  // needs the bucket expression, mirroring lib/db/queries.ts's day-bucket idiom.
  const monthExpr = sql`to_char(to_timestamp(classified_at) AT TIME ZONE 'UTC', 'YYYY-MM')`;
  const classificationsByMonth = await rawAll<{
    user_id: string; month: string; tier: number; cnt: number | string;
  }>(client, sql`
     SELECT user_id,
            ${monthExpr} AS month,
            tier,
            COUNT(*) AS cnt
     FROM pulse_classifications
     WHERE classifier_status = 'classified'
       AND classified_at >= ${sixMonthsAgo}
     GROUP BY user_id, month, tier
     ORDER BY user_id, month, cnt DESC
  `);

  // For each user+month, keep only the dominant tier (first row per user+month after sort)
  const dominantMap = new Map<string, number>(); // "user_id|month" -> dominant tier
  for (const row of classificationsByMonth) {
    const key = `${row.user_id}|${row.month}`;
    if (!dominantMap.has(key)) dominantMap.set(key, row.tier);
  }

  // Count users per month per dominant tier
  const funnelCounts = new Map<string, { tier1: number; tier2: number; tier3: number }>();
  for (const [key, tier] of dominantMap) {
    const month = key.split('|')[1];
    const entry = funnelCounts.get(month) ?? { tier1: 0, tier2: 0, tier3: 0 };
    if (tier === 1) entry.tier1++;
    else if (tier === 2) entry.tier2++;
    else if (tier === 3) entry.tier3++;
    funnelCounts.set(month, entry);
  }

  const adoptionFunnel = Array.from(funnelCounts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, counts]) => ({ month, ...counts }));

  // ── AI Intelligence Briefing ───────────────────────────────────────────────

  const briefingRows = await client
    .select({
      body: schema.pulseBriefings.body,
      suggestion: schema.pulseBriefings.suggestion,
      generated_at: schema.pulseBriefings.generated_at,
    })
    .from(schema.pulseBriefings)
    .where(and(eq(schema.pulseBriefings.scope_type, 'organisation'), eq(schema.pulseBriefings.scope_id, 'org')))
    .orderBy(desc(schema.pulseBriefings.generated_at))
    .limit(1);
  const briefing = briefingRows[0];

  // ── Capability creation log ────────────────────────────────────────────────

  const capabilityRows = await client
    .select({
      id: pe.id,
      title: pe.title,
      body: pe.body,
      tier: pe.tier,
      detected_at: pe.detected_at,
      confirmed_at: pe.confirmed_at,
      user_id: pe.user_id,
      display_name: schema.users.display_name,
      email: schema.users.email,
      team_id: schema.users.team_id,
      department: schema.users.department,
      content_preview: schema.coworkMessages.content_preview,
    })
    .from(pe)
    .leftJoin(schema.users, eq(schema.users.id, pe.user_id))
    .leftJoin(schema.coworkMessages, eq(schema.coworkMessages.id, pe.cowork_message_id))
    .where(and(eq(pe.event_type, 'capability_creation'), eq(pe.status, 'confirmed')))
    .orderBy(desc(pe.confirmed_at))
    .limit(50);

  // content_preview is the first 250 characters of the person's prompt, and
  // body quotes up to 300 more. This page is open to viewers, so the text
  // follows the Audit Log rule (admin, or manager in their own department);
  // everyone keeps the title, person, date and tier.
  const promptVisible = await promptTextVisibleFor(session, capabilityRows.map(r => r.user_id));
  const capabilityLog = capabilityRows.map(r =>
    r.user_id && promptVisible.has(r.user_id) ? r : { ...r, body: null, content_preview: null });
  if (promptVisible.size > 0) await logPromptRead(request, session, 'pulse/cio/capability-log');

  // ── Org-wide weekly volume trend ───────────────────────────────────────────
  // pulse_metrics has no 'organisation' scope — only 'user' | 'team' | 'function'
  // weekly rows are written (lib/pulse/aggregator.ts). Department ('function')
  // rows only cover users whose admin_users record has both a department and a
  // linked_cowork_user_id, which can under-count the org. Summing the 'user'
  // scope weekly rows instead covers every classified user, matching how the
  // rest of this route already aggregates (avgDds/avgOti above use
  // `scope_type = 'user'`) — the simplest option consistent with the existing
  // query pattern. Missing weeks / users contribute 0, not null, since this is
  // a sum across many rows rather than a single scope's series.
  // These columns are interpolated into raw SQL below (hand-rolled GROUP BY
  // summation, not the getWeeklySeries/getWeeklyDelta helpers), so they must
  // be checked against the same allowlist those helpers use
  // (lib/pulse/trends.ts COLUMN_ALLOWLIST.pulse_metrics) before use.
  assertPulseMetricsColumn('event_count');
  assertPulseMetricsColumn('tier_3_count');

  const orgWeeks = weekStarts(now, 8);
  const orgCurrentWeek = weekStart(now);
  const weeklyUserRows = await client
    .select({
      period_start: pm.period_start,
      event_count: sql<number | string | null>`SUM(${pm.event_count})`,
      tier_3_count: sql<number | string | null>`SUM(${pm.tier_3_count})`,
    })
    .from(pm)
    .where(and(eq(pm.granularity, 'week'), eq(pm.scope_type, 'user'), gte(pm.period_start, orgWeeks[0])))
    .groupBy(pm.period_start);
  const weeklyByWeek = new Map(weeklyUserRows.map(r => [r.period_start, {
    event_count: r.event_count !== null ? Number(r.event_count) : null,
    tier_3_count: r.tier_3_count !== null ? Number(r.tier_3_count) : null,
  }]));

  const weeklyVolume = orgWeeks.map(ws => {
    const row = weeklyByWeek.get(ws);
    return {
      weekStart: ws,
      eventCount: row ? (row.event_count ?? 0) : 0,
      tier3Count: row ? (row.tier_3_count ?? 0) : 0,
      partial: ws === orgCurrentWeek,
    };
  });

  // Completed-week delta for event_count (volume), same convention as Developer Pulse.
  const completedVolume = weeklyVolume.filter(w => !w.partial);
  const currentVol = completedVolume.length > 0 ? completedVolume[completedVolume.length - 1].eventCount : null;
  const priorVol = completedVolume.length > 1 ? completedVolume[completedVolume.length - 2].eventCount : null;
  const volumePct = priorVol !== null && priorVol !== 0 && currentVol !== null ? (currentVol - priorVol) / priorVol : null;

  // Same completed-week delta convention for tier_3_count (frontier work volume).
  const currentTier3 = completedVolume.length > 0 ? completedVolume[completedVolume.length - 1].tier3Count : null;
  const priorTier3 = completedVolume.length > 1 ? completedVolume[completedVolume.length - 2].tier3Count : null;
  const tier3Pct = priorTier3 !== null && priorTier3 !== 0 && currentTier3 !== null ? (currentTier3 - priorTier3) / priorTier3 : null;

  // OTel cowork enrichments — org-wide 7-day cost
  const orgCoworkCostRows = await client
    .select({ cowork_cost: sql<number | string>`COALESCE(SUM(${schema.coworkMessages.cost_usd}), 0)` })
    .from(schema.coworkMessages)
    .where(and(eq(schema.coworkMessages.message_type, 'cowork_api_request'), gte(schema.coworkMessages.occurred_at, sevenDaysAgo)));
  const orgCoworkCostUsd = Number(orgCoworkCostRows[0]?.cowork_cost ?? 0);

  // ── Files touched by category — org-wide, 30-day window ────────────────────
  const fileCategoryMix = await getFileCategoryMix(30);

  // ── Delegation depth over time ────────────────────────────────────────────
  // Weekly 'function'-scope rows per department; current week excluded.
  const weeksParamRaw = Number(request.nextUrl.searchParams.get('weeks'));
  const delegationWindow = ([13, 26, 52] as const).includes(weeksParamRaw as 13 | 26 | 52)
    ? (weeksParamRaw as 13 | 26 | 52) : 26;
  // weekStarts ends with the current (partial) week — take the N before it.
  const delegationWeeks = weekStarts(now, delegationWindow + 1).slice(0, delegationWindow);

  const deptWeekRowsRaw = await client
    .select({
      scope_id: pm.scope_id, period_start: pm.period_start,
      t1: pm.tier_1_count, t2: pm.tier_2_count, t3: pm.tier_3_count,
    })
    .from(pm)
    .where(and(
      eq(pm.granularity, 'week'), eq(pm.scope_type, 'function'),
      gte(pm.period_start, delegationWeeks[0]), lt(pm.period_start, weekStart(now)),
    ));
  const deptWeekRows: DelegationWeekRow[] = deptWeekRowsRaw.map(r => ({
    scopeId: r.scope_id, periodStart: Number(r.period_start),
    t1: Number(r.t1), t2: Number(r.t2), t3: Number(r.t3),
  }));

  // A rubric save never splits the delegation charts or restarts then-vs-now:
  // admins update the tiers often, and splitting on each save would blank the
  // department arrows for four weeks. Saves are still logged in
  // pulse_rubric_versions; they do not segment the charts.
  const rubricChangesAtS: number[] = [];

  // Org-wide tier bands: USER-scope weekly rows summed per week — covers every
  // classified user, including people with no resolvable department (the
  // 'function' rows only cover admin_users-linked departments). Same idiom as
  // the weeklyVolume block above, which also aggregates the 'user' scope.
  const userWeekRowsRaw = await client
    .select({
      period_start: pm.period_start,
      t1: sql<number | string | null>`SUM(${pm.tier_1_count})`,
      t2: sql<number | string | null>`SUM(${pm.tier_2_count})`,
      t3: sql<number | string | null>`SUM(${pm.tier_3_count})`,
    })
    .from(pm)
    .where(and(
      eq(pm.granularity, 'week'), eq(pm.scope_type, 'user'),
      gte(pm.period_start, delegationWeeks[0]), lt(pm.period_start, weekStart(now)),
    ))
    .groupBy(pm.period_start);
  const ORG_DELEGATION_SCOPE = '__org__';
  const orgWeekRows: DelegationWeekRow[] = userWeekRowsRaw.map(r => ({
    scopeId: ORG_DELEGATION_SCOPE, periodStart: Number(r.period_start),
    t1: Number(r.t1 ?? 0), t2: Number(r.t2 ?? 0), t3: Number(r.t3 ?? 0),
  }));
  const orgBands = buildBandSegments(orgWeekRows, ORG_DELEGATION_SCOPE, delegationWeeks, rubricChangesAtS);
  const orgBandsDataWeeks = countDataWeeks(
    buildDepthSegments(orgWeekRows, ORG_DELEGATION_SCOPE, delegationWeeks, rubricChangesAtS, 0));

  // Departments render as then-vs-now rows (arrow + sparkline), mirroring the
  // dept page's people list one level up, replacing the
  // original per-dept line chart.
  const deptIds = [...new Set(deptWeekRows.map(r => r.scopeId))].sort();
  const delegationDepartments: Array<{
    dept: string;
    sparkline: Array<number | null>;
    thenVsNow: ReturnType<typeof buildThenVsNow>;
    dataWeeks: number;
  }> = [];
  const delegationBuilding: Array<{ dept: string; dataWeeks: number }> = [];
  for (const dept of deptIds) {
    // Dept rows aggregate many users — no per-week event floor (pass 0).
    const segments = buildDepthSegments(deptWeekRows, dept, delegationWeeks, rubricChangesAtS, 0);
    const allDataWeeks = countDataWeeks(segments);
    if (allDataWeeks >= MIN_CHART_DATA_WEEKS) {
      delegationDepartments.push({
        dept,
        // Null gap between segments so a rubric break renders as a gap.
        sparkline: segments.flatMap((s, i) =>
          i === 0 ? s.points.map(p => p.depth) : [null, ...s.points.map(p => p.depth)]),
        thenVsNow: buildThenVsNow(segments),
        // Latest-segment count — matches what then-vs-now judges.
        dataWeeks: countLatestSegmentDataWeeks(segments),
      });
    } else if (allDataWeeks > 0) {
      delegationBuilding.push({ dept, dataWeeks: allDataWeeks });
    }
  }
  // Departments sort improvement-first: ranking
  // teams is exactly what the exec view is for; people (dept page) sort
  // alphabetically instead. Rows without a then-vs-now reading sink last.
  delegationDepartments.sort((a, b) => {
    if (a.thenVsNow === null && b.thenVsNow === null) return a.dept.localeCompare(b.dept);
    if (a.thenVsNow === null) return 1;
    if (b.thenVsNow === null) return -1;
    return b.thenVsNow.deltaPp - a.thenVsNow.deltaPp;
  });

  // ── Act-next list (Workflow Impact) — additive, never blocks the page ──
  let actNext: ActNextRow[] = [];
  try {
    actNext = await buildActNext(session.role ?? 'viewer', now);
  } catch {
    actNext = [];
  }

  // ── Department process boxes (Department Process Transformation) —
  // additive, never blocks the page. Mapped down to ids + titles only — no
  // canvas/evidence in this response; the canvas modal lives on /use-cases. ──
  type IdTitle = { id: string; title: string };
  let deptProcesses: Array<{ department: string; key: string; label: string; count: number; suggestions: IdTitle[]; groups: Array<{ surface: string; label: string; suggestions: IdTitle[] }> }> = [];
  try {
    const boxes: DeptProcessBox[] = await buildDeptProcessBoxes();
    deptProcesses = boxes.map(box => ({
      department: box.department,
      key: box.key,
      label: box.label,
      count: box.count,
      suggestions: box.suggestions.map(s => ({ id: s.id, title: s.title })),
      groups: box.groups.map(g => ({ surface: g.surface, label: g.label, suggestions: g.suggestions.map(s => ({ id: s.id, title: s.title })) })),
    }));
  } catch {
    deptProcesses = [];
  }

  return NextResponse.json({
    adoptionFunnel,
    adoptionHero: {
      weeklyActive,
      totalActive,
      meaningfulWorkPct,
      avgDds,
      avgOti,
      concentrationPct,
      // Prior period for deltas
      priorWeeklyActive,
      priorMeaningfulWorkPct,
      priorAvgDds,
      priorAvgOti,
    },
    signalCards,
    briefing: briefing ?? null,
    capabilityLog,
    coworkCostUsd: orgCoworkCostUsd,
    fileCategoryMix,
    weeklyVolume: {
      series: weeklyVolume,
      delta: { current: currentVol, prior: priorVol, pct: volumePct },
      tier3Delta: { current: currentTier3, prior: priorTier3, pct: tier3Pct },
    },
    delegation: {
      window: delegationWindow,
      org: { bands: orgBands, bandsDataWeeks: orgBandsDataWeeks },
      departments: delegationDepartments,
      building: delegationBuilding,
    },
    actNext,
    deptProcesses,
  });
}
