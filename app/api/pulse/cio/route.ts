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
import { parseVendor, type Vendor } from '@/lib/dashboard/vendor';
import { hasOpenAiData } from '@/lib/dashboard/queries';
import { vendorClause } from '@/lib/dashboard/product-sql';
import { messageVendor } from '@/lib/pulse/vendor-filter';
import { chatgptCostUsd } from '@/lib/openai/spend';

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

  const cm = schema.coworkMessages;
  const pmv = schema.pulseMetricsVendor;

  // The Claude / OpenAI switch. 'all' reads every product, as before; a vendor
  // narrows classifications by their prompt's source and reads the aggregator's
  // per-vendor figures (pulse_metrics_vendor).
  const vendor = parseVendor(request.nextUrl.searchParams.get('vendor'));
  const openaiPresent = await hasOpenAiData();

  // Same columns in both tables, so a vendor view reads pulse_metrics_vendor
  // through pulse_metrics' column set, narrowed to that vendor.
  const metricsFor = (v: Vendor) => v === 'all'
    ? { t: pm, only: sql`TRUE` }
    : { t: pmv as unknown as typeof pm, only: eq(pmv.vendor, v) };

  const round2 = (v: number | string | null | undefined): number | null =>
    v !== null && v !== undefined ? Math.round(Number(v) * 100) / 100 : null;

  /** People with classified work between `from` and `to` (classified_at). */
  async function distinctPeople(v: Vendor, from: number, to?: number): Promise<number> {
    const rows = await client
      .select({ cnt: sql<number | string>`COUNT(DISTINCT ${pc.user_id})` })
      .from(pc)
      .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
      .where(and(gte(pc.classified_at, from), to !== undefined ? lt(pc.classified_at, to) : undefined,
        eq(pc.classifier_status, 'classified'), messageVendor(v)));
    return Number(rows[0]?.cnt ?? 0);
  }

  /** Share of classified work at Tier 2 or 3, whole per cent; null with no work. */
  async function meaningfulPct(v: Vendor, from: number, to?: number): Promise<number | null> {
    const rows = await client
      .select({ tier: pc.tier, cnt: sql<number | string>`COUNT(*)` })
      .from(pc)
      .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
      .where(and(gte(pc.classified_at, from), to !== undefined ? lt(pc.classified_at, to) : undefined,
        eq(pc.classifier_status, 'classified'), messageVendor(v)))
      .groupBy(pc.tier);
    const counts = { 1: 0, 2: 0, 3: 0 };
    for (const row of rows) {
      if (row.tier === 1 || row.tier === 2 || row.tier === 3) counts[row.tier] = Number(row.cnt);
    }
    const total = counts[1] + counts[2] + counts[3];
    return total > 0 ? Math.round(((counts[2] + counts[3]) / total) * 100) : null;
  }

  /** Average of a person-level rolling figure (DDS or OTI) computed in the window. */
  async function avgUserMetric(v: Vendor, col: 'dds' | 'oti', from: number, to?: number): Promise<number | null> {
    const { t, only } = metricsFor(v);
    const rows = await client
      .select({ v: sql<number | string | null>`AVG(${t[col]})` })
      .from(t)
      .where(and(only, eq(t.scope_type, 'user'), isNotNull(t[col]), eq(t.granularity, 'rolling'),
        gte(t.computed_at, from), to !== undefined ? lt(t.computed_at, to) : undefined));
    return round2(rows[0]?.v);
  }

  /** The headline strip for one view. */
  async function heroFor(v: Vendor) {
    return {
      weeklyActive: await distinctPeople(v, sevenDaysAgo),
      priorWeeklyActive: await distinctPeople(v, fourteenDaysAgo, sevenDaysAgo),
      totalActive: await distinctPeople(v, fourteenDaysAgo),
      meaningfulWorkPct: await meaningfulPct(v, thirtyDaysAgo),
      priorMeaningfulWorkPct: await meaningfulPct(v, sixtyDaysAgo, thirtyDaysAgo),
      avgDds: await avgUserMetric(v, 'dds', sevenDaysAgo),
      priorAvgDds: await avgUserMetric(v, 'dds', sixtyDaysAgo, sevenDaysAgo),
      avgOti: await avgUserMetric(v, 'oti', sevenDaysAgo),
      priorAvgOti: await avgUserMetric(v, 'oti', sixtyDaysAgo, sevenDaysAgo),
    };
  }

  // ── Adoption hero numbers ─────────────────────────────────────────────────
  const hero = await heroFor(vendor);
  // In the All view with both vendors present, each headline figure also
  // carries its Claude and OpenAI parts.
  const heroSplit = vendor === 'all' && openaiPresent
    ? { claude: await heroFor('claude'), openai: await heroFor('openai') }
    : null;

  // Capability concentration risk — % of Tier 3 tasks on top 3 users
  const tier3UserCounts = await client
    .select({ user_id: pc.user_id, cnt: sql<number | string>`COUNT(*)` })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .where(and(eq(pc.tier, 3), eq(pc.classifier_status, 'classified'), gte(pc.classified_at, fourteenDaysAgo), messageVendor(vendor)))
    .groupBy(pc.user_id)
    .orderBy(desc(sql`COUNT(*)`));

  const totalTier3 = tier3UserCounts.reduce((s, r) => s + Number(r.cnt), 0);
  const top3Tier3 = tier3UserCounts.slice(0, 3).reduce((s, r) => s + Number(r.cnt), 0);
  const concentrationPct = totalTier3 > 0
    ? Math.round((top3Tier3 / totalTier3) * 100)
    : 0;

  // ── Org-level signal cards ─────────────────────────────────────────────────

  // Confirmed capabilities; in a vendor view, those detected on that vendor's prompts.
  const orgPsrRows = vendor === 'all'
    ? await client
      .select({ v: sql<number | string>`COUNT(*)` })
      .from(pe)
      .where(and(eq(pe.event_type, 'capability_creation'), eq(pe.status, 'confirmed')))
    : await client
      .select({ v: sql<number | string>`COUNT(*)` })
      .from(pe)
      .innerJoin(cm, eq(cm.id, pe.cowork_message_id))
      .where(and(eq(pe.event_type, 'capability_creation'), eq(pe.status, 'confirmed'), messageVendor(vendor)));
  const orgPsr = Number(orgPsrRows[0]?.v ?? 0);

  // ORS is only ever computed at group level (scope_type='team' keyed by
  // users.team_id, or scope_type='function' keyed by admin_users.department
  // — see lib/pulse/aggregator.ts). users.team_id is never populated in any
  // real deployment (no admin UI, no ingest default),
  // so 'team' rows never exist; 'function' (department) is the
  // scope that's actually written and populated. The composite and its three
  // components are averages of the per-department figures.
  const orsTable = metricsFor(vendor);
  const orgOrsRows = await client
    .select({
      ors: sql<number | string | null>`AVG(${orsTable.t.ors})`,
      breadth: sql<number | string | null>`AVG(${orsTable.t.ors_breadth})`,
      overlap: sql<number | string | null>`AVG(${orsTable.t.ors_overlap})`,
      propagation: sql<number | string | null>`AVG(${orsTable.t.ors_propagation})`,
    })
    .from(orsTable.t)
    .where(and(orsTable.only, eq(orsTable.t.scope_type, 'function'), isNotNull(orsTable.t.ors),
      eq(orsTable.t.granularity, 'rolling'), gte(orsTable.t.computed_at, sevenDaysAgo)));
  const orgOrs = orgOrsRows[0];

  const signalCards = {
    oti: hero.avgOti,
    dds: hero.avgDds,
    psr: orgPsr,
    ors: round2(orgOrs?.ors),
    orsBreadth: round2(orgOrs?.breadth),
    orsOverlap: round2(orgOrs?.overlap),
    orsPropagation: round2(orgOrs?.propagation),
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
     SELECT pulse_classifications.user_id,
            ${monthExpr} AS month,
            tier,
            COUNT(*) AS cnt
     FROM pulse_classifications
     JOIN cowork_messages ON cowork_messages.id = pulse_classifications.cowork_message_id
     WHERE classifier_status = 'classified'
       AND classified_at >= ${sixMonthsAgo}
       AND ${sql.raw(vendorClause(vendor, 'cowork_messages.'))}
     GROUP BY pulse_classifications.user_id, month, tier
     ORDER BY pulse_classifications.user_id, month, cnt DESC
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
    .where(and(eq(pe.event_type, 'capability_creation'), eq(pe.status, 'confirmed'),
      vendor === 'all' ? undefined : messageVendor(vendor)))
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
  const wm = metricsFor(vendor);
  const weeklyUserRows = await client
    .select({
      period_start: wm.t.period_start,
      event_count: sql<number | string | null>`SUM(${wm.t.event_count})`,
      tier_3_count: sql<number | string | null>`SUM(${wm.t.tier_3_count})`,
    })
    .from(wm.t)
    .where(and(wm.only, eq(wm.t.granularity, 'week'), eq(wm.t.scope_type, 'user'), gte(wm.t.period_start, orgWeeks[0])))
    .groupBy(wm.t.period_start);
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

  // OTel cowork enrichments — org-wide 7-day cost, Claude Cowork only.
  // ChatGPT's spend comes from OpenAI's cost records, read apart below.
  const orgCoworkCostRows = await client
    .select({ cowork_cost: sql<number | string>`COALESCE(SUM(${schema.coworkMessages.cost_usd}), 0)` })
    .from(schema.coworkMessages)
    .where(and(eq(schema.coworkMessages.message_type, 'cowork_api_request'), gte(schema.coworkMessages.occurred_at, sevenDaysAgo)));
  const orgCoworkCostUsd = Number(orgCoworkCostRows[0]?.cowork_cost ?? 0);
  const orgChatgptCostUsd = vendor === 'claude' || !openaiPresent ? undefined : await chatgptCostUsd({ since: sevenDaysAgo });

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
      scope_id: wm.t.scope_id, period_start: wm.t.period_start,
      t1: wm.t.tier_1_count, t2: wm.t.tier_2_count, t3: wm.t.tier_3_count,
    })
    .from(wm.t)
    .where(and(
      wm.only, eq(wm.t.granularity, 'week'), eq(wm.t.scope_type, 'function'),
      gte(wm.t.period_start, delegationWeeks[0]), lt(wm.t.period_start, weekStart(now)),
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
      period_start: wm.t.period_start,
      t1: sql<number | string | null>`SUM(${wm.t.tier_1_count})`,
      t2: sql<number | string | null>`SUM(${wm.t.tier_2_count})`,
      t3: sql<number | string | null>`SUM(${wm.t.tier_3_count})`,
    })
    .from(wm.t)
    .where(and(
      wm.only, eq(wm.t.granularity, 'week'), eq(wm.t.scope_type, 'user'),
      gte(wm.t.period_start, delegationWeeks[0]), lt(wm.t.period_start, weekStart(now)),
    ))
    .groupBy(wm.t.period_start);
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
    vendor,
    openaiPresent,
    adoptionFunnel,
    adoptionHero: { ...hero, concentrationPct },
    heroSplit,
    signalCards,
    briefing: briefing ?? null,
    capabilityLog,
    coworkCostUsd: vendor === 'openai' ? undefined : orgCoworkCostUsd,
    chatgptCostUsd: orgChatgptCostUsd,
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
