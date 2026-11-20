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
import { visibleVendor, visibleOpenAi } from '@/lib/sources/openai-visibility';
import { and, desc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { getAdminSession, canAccessOrgOverview } from '@/lib/auth/admin-auth';
import { getConfigValue } from '@/lib/config';
import { promptTextVisibleFor, logPromptRead } from '@/lib/auth/content-access';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { weekStart, weekStarts } from '@/lib/pulse/period';
import {
  buildBandSegments, buildDepthSegments, buildThenVsNow,
  countDataWeeks, countLatestSegmentDataWeeks, MIN_CHART_DATA_WEEKS,
  type DelegationWeekRow,
} from '@/lib/pulse/delegation';
import { buildActNext, buildDeptProcessBoxes, type ActNextRow } from '@/lib/pulse/act-next';
import type { DeptProcessBox } from '@/lib/usecases/suggestion-store';
import { type Vendor } from '@/lib/dashboard/vendor';
import { hasOpenAiData } from '@/lib/dashboard/queries';
import { messageVendor } from '@/lib/pulse/vendor-filter';

import { keptFigures } from '@/lib/kept-figures';
import { errorResponse } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated || !canAccessOrgOverview(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    const sp = request.nextUrl.searchParams;
    // Kept per view, window and viewer for five minutes (lib/kept-figures.ts): the
    // act-next list follows the role, and the capability log's prompt text follows the viewer's
    // role and department (gateContentRead). ?fresh=1 after an action on the page. A result with
    // a part that failed is not kept.
    const key = ['cio', sp.get('vendor') ?? '', sp.get('weeks') ?? '', session.role ?? '', session.department ?? '', session.email ?? ''].join('\u0000');
    const { promptRead, ...body } = await keptFigures(key, () => buildCio(session, sp), { keep: b => b.failed.length === 0, force: sp.get('fresh') === '1' });
    // Every visit that shows prompt text is recorded, whether the figures were kept or built.
    if (promptRead) await logPromptRead(request, session, 'pulse/cio/capability-log');
    return NextResponse.json(body);
  } catch (err) {
    return errorResponse('pulse/cio', err);
  }
}

async function buildCio(session: Awaited<ReturnType<typeof getAdminSession>>, searchParams: URLSearchParams) {
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
  const vendor = await visibleVendor(searchParams.get('vendor'));
  const openaiPresent = await visibleOpenAi(hasOpenAiData());

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
  // Whether this viewer is shown prompt text: recorded by the request on every visit, kept or not.
  const promptRead = promptVisible.size > 0;

  const wm = metricsFor(vendor);

  // ── Delegation depth over time ────────────────────────────────────────────
  // Weekly 'function'-scope rows per department; current week excluded.
  const weeksParamRaw = Number(searchParams.get('weeks'));
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
  // Parts that failed to build: their panels say they couldn't load, never look empty.
  const failed: string[] = [];
  let actNext: ActNextRow[] = [];
  try {
    actNext = await buildActNext(session.role ?? 'viewer', now);
  } catch (e) {
    console.error('[pulse/cio] act-next failed', e);
    actNext = [];
    failed.push('actNext');
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
      suggestions: box.suggestions.map(s => ({ id: s.id, title: s.title, people: s.canvas?.people ?? null })),
      groups: box.groups.map(g => ({ surface: g.surface, label: g.label, suggestions: g.suggestions.map(s => ({ id: s.id, title: s.title })) })),
    }));
  } catch (e) {
    console.error('[pulse/cio] department processes failed', e);
    deptProcesses = [];
    failed.push('deptProcesses');
  }

  const realWorkFloorRaw = await getConfigValue('targetDeptRealWorkPct');

  return {
    promptRead,
    vendor,
    openaiPresent,
    failed,
    adoptionHero: { ...hero, concentrationPct },
    signalCards,
    briefing: briefing ?? null,
    capabilityLog,
    delegation: {
      window: delegationWindow,
      org: {
        bands: orgBands, bandsDataWeeks: orgBandsDataWeeks,
        // Completed weeks' task counts by tier, oldest first (additive), for the depth columns.
        weeks: [...orgWeekRows].sort((a, b) => a.periodStart - b.periodStart).map(r => ({ weekStart: r.periodStart, t1: r.t1, t2: r.t2, t3: r.t3 })),
      },
      departments: delegationDepartments,
      building: delegationBuilding,
    },
    actNext,
    deptProcesses,
    // Each department's share of tasks that were real work (meaningful or frontier) over the last
    // 4 completed weeks, from the same weekly department rows as the delegation chart (additive).
    deptRealWork: (() => {
      const recent = new Set(delegationWeeks.slice(-4));
      const by = new Map<string, { real: number; all: number }>();
      for (const r of deptWeekRows) {
        if (!recent.has(r.periodStart)) continue;
        const b = by.get(r.scopeId) ?? { real: 0, all: 0 };
        b.real += r.t2 + r.t3; b.all += r.t1 + r.t2 + r.t3;
        by.set(r.scopeId, b);
      }
      return [...by.entries()].filter(([, b]) => b.all > 0)
        .map(([dept, b]) => ({ dept, share: b.real / b.all, tasks: b.all }))
        .sort((a, b) => b.share - a.share);
    })(),
    // The floor for that share (Admin → System), a percentage; null when switched off.
    realWorkFloorPct: (() => {
      const n = Number(realWorkFloorRaw);
      return realWorkFloorRaw === '' ? 33 : Number.isFinite(n) && n > 0 && n <= 100 ? n : null;
    })(),
  };
}
