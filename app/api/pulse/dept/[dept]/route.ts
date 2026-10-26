// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table> for
// most reads (inArray for dynamic member-id lists), and a local rawAll()
// facade for the two "latest row per scope" tuple-IN-subquery reads
// (teamMetricsRow, memberMetrics) — far clearer as raw SQL than a Drizzle
// query-builder equivalent, and the exact shape
// test/pulse-granularity-readers.test.ts already pins for this route's
// sibling (depts route). Postgres supports row-value
// `(a, b) IN (SELECT a, MAX(b) ... GROUP BY a)` natively. Every raw-SQL COUNT/SUM/AVG aggregate is Number()-coerced
// (bigint/numeric come back as STRINGS on Postgres). The
// per-member friction-index query mirrors lib/pulse/aggregator.ts's
// getCoworkFrictionIndex's COUNT(*) FILTER (WHERE ...) idiom (native on
// Postgres).
import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, gt, gte, inArray, lt, lte, notInArray, sql } from 'drizzle-orm';
import { getAdminSession, isDeptScoped, canAccessCoworkPulse, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { buildFrontierView, resolveViewerUserId } from '@/lib/pulse/frontier-view';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getCoworkCostUsd } from '@/lib/pulse/aggregator';
import { weekStart, weekStarts } from '@/lib/pulse/period';
import {
  buildDepthSegments, buildBandSegments, buildThenVsNow, countDataWeeks, countLatestSegmentDataWeeks,
  type DelegationWeekRow,
} from '@/lib/pulse/delegation';
import { getDeptCoachingPrompts } from '@/lib/usecases/spread';
import { readHumanTime } from '@/lib/pulse/human-time-summary';

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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ dept: string }> }
) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessCoworkPulse(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const dept = decodeURIComponent((await params).dept);
  if (isDeptScoped(session.role)) {
    if (!session.department) {
      return NextResponse.json(
        { error: 'no_department', message: 'Your account has no department assigned. Ask your admin to set one.' },
        { status: 422 }
      );
    }
    if (dept !== session.department) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }
  const client = await getTypedClient();
  const now = Math.floor(Date.now() / 1000);
  const sixWeeksAgo = now - 42 * 24 * 3600;
  const twoWeeksAgo = now - 14 * 24 * 3600;

  const u = schema.users;
  const pm = schema.pulseMetrics;
  const pc = schema.pulseClassifications;
  const cm = schema.coworkMessages;
  const csi = schema.coworkSkillInvocations;
  const cmi = schema.coworkMcpInvocations;
  const pb = schema.pulseBriefings;
  const css = schema.coworkSessionStats;
  const cs = schema.coworkSessions;

  // Department members
  const members = await client
    .select({ id: u.id, display_name: u.display_name, email: u.email })
    .from(u)
    .where(eq(u.department, dept));

  const memberIds = members.map(m => m.id);

  // Display-name precedence: admin_users (via linked_cowork_user_id) > users.display_name
  // > users.email > id — mirrors the COALESCE(admin_users, users) pattern used elsewhere
  // (e.g. the Developer Pulse friction card, app/api/events/route.ts).
  const adminDisplayRows = memberIds.length === 0 ? [] : await client
    .select({
      linked_cowork_user_id: schema.adminUsers.linked_cowork_user_id,
      display_name: schema.adminUsers.display_name,
    })
    .from(schema.adminUsers)
    .where(inArray(schema.adminUsers.linked_cowork_user_id, memberIds));
  const adminDisplayById = new Map<string, string>(
    adminDisplayRows
      .filter((r): r is { linked_cowork_user_id: string; display_name: string } =>
        !!r.linked_cowork_user_id && !!r.display_name)
      .map(r => [r.linked_cowork_user_id, r.display_name])
  );
  const displayNameById = new Map<string, string>(
    members.map(m => [m.id, adminDisplayById.get(m.id) ?? m.display_name ?? m.email ?? m.id])
  );

  if (memberIds.length === 0) {
    return NextResponse.json({
      dept,
      members: [],
      memberMetrics: [],
      metrics: null,
      journeyHeatmap: [],
      concentrationRisk: [],
      concentrationDetail: [],
      skillConcentration: [],
      frontier: null,
      toolsUsed: [],
    });
  }

  const memberIdsSql = sql.join(memberIds.map(id => sql`${id}`), sql`, `);

  // Team-level PSR and ORS: average across teams whose members are in this dept
  // PSR and ORS are scope_type='team' — the function-level aggregator does not compute them
  const teamMetricsRows = await rawAll<{
    avg_psr: number | string | null; avg_ors: number | string | null;
    avg_ors_breadth: number | string | null; avg_ors_overlap: number | string | null; avg_ors_propagation: number | string | null;
  }>(client, sql`
     SELECT AVG(tm.psr) AS avg_psr, AVG(tm.ors) AS avg_ors,
            AVG(tm.ors_breadth) AS avg_ors_breadth,
            AVG(tm.ors_overlap) AS avg_ors_overlap,
            AVG(tm.ors_propagation) AS avg_ors_propagation
     FROM (
       SELECT DISTINCT team_id FROM users WHERE id IN (${memberIdsSql}) AND team_id IS NOT NULL
     ) t
     JOIN (
       SELECT scope_id AS team_id, psr, ors, ors_breadth, ors_overlap, ors_propagation
       FROM pulse_metrics
       WHERE scope_type = 'team' AND granularity = 'rolling'
         AND (scope_id, computed_at) IN (
           SELECT scope_id, MAX(computed_at)
           FROM pulse_metrics
           WHERE scope_type = 'team' AND granularity = 'rolling'
           GROUP BY scope_id
         )
     ) tm ON tm.team_id = t.team_id
  `);
  const teamMetricsRow = teamMetricsRows[0];
  const numOrNull = (v: number | string | null | undefined): number | null =>
    v !== null && v !== undefined ? Number(v) : null;
  const deptPsr = numOrNull(teamMetricsRow?.avg_psr);
  const deptOrs = numOrNull(teamMetricsRow?.avg_ors);
  const deptOrsBreadth = numOrNull(teamMetricsRow?.avg_ors_breadth);
  const deptOrsOverlap = numOrNull(teamMetricsRow?.avg_ors_overlap);
  const deptOrsPropagation = numOrNull(teamMetricsRow?.avg_ors_propagation);

  // Latest dept-level metrics (written as scope_type='function' by the daily aggregator)
  const metricsRows = await client
    .select({
      oti: pm.oti, dds: pm.dds, psr: pm.psr, ors: pm.ors, event_count: pm.event_count,
      tier_1_count: pm.tier_1_count, tier_2_count: pm.tier_2_count, tier_3_count: pm.tier_3_count,
      computed_at: pm.computed_at,
      ors_breadth: pm.ors_breadth, ors_overlap: pm.ors_overlap, ors_propagation: pm.ors_propagation,
    })
    .from(pm)
    .where(and(eq(pm.scope_type, 'function'), eq(pm.scope_id, dept), eq(pm.granularity, 'rolling')))
    .orderBy(desc(pm.computed_at))
    .limit(1);
  const metrics = metricsRows[0];

  // Prior period dept metrics: row closest to 7 days ago for meaningful week-over-week delta
  const sevenDaysAgo = now - 7 * 24 * 3600;
  const priorMetricsRows = await client
    .select({ oti: pm.oti, dds: pm.dds, psr: pm.psr, ors: pm.ors, computed_at: pm.computed_at })
    .from(pm)
    .where(and(eq(pm.scope_type, 'function'), eq(pm.scope_id, dept), eq(pm.granularity, 'rolling'), lte(pm.computed_at, sevenDaysAgo)))
    .orderBy(desc(pm.computed_at))
    .limit(1);
  const priorMetrics = priorMetricsRows[0];

  // Per-member metrics: latest user-scoped pulse_metrics + last active
  const memberMetrics = await rawAll<{
    id: string; display_name: string | null; email: string;
    dds: number | string | null; oti: number | string | null; last_active: number | string | null;
  }>(client, sql`
     SELECT
       u.id,
       u.display_name,
       u.email,
       pm.dds,
       pm.oti,
       (SELECT MAX(classified_at) FROM pulse_classifications
        WHERE user_id = u.id AND classifier_status = 'classified') AS last_active
     FROM users u
     LEFT JOIN (
       SELECT scope_id AS user_id, dds, oti
       FROM pulse_metrics
       WHERE scope_type = 'user' AND granularity = 'rolling'
         AND (scope_id, computed_at) IN (
           SELECT scope_id, MAX(computed_at) FROM pulse_metrics
           WHERE scope_type = 'user' AND granularity = 'rolling' GROUP BY scope_id
         )
     ) pm ON pm.user_id = u.id
     WHERE u.department = ${dept}
     ORDER BY pm.dds DESC NULLS LAST, u.display_name
  `).then(rows => rows.map(r => ({
    id: r.id, display_name: r.display_name, email: r.email,
    dds: numOrNull(r.dds), oti: numOrNull(r.oti), last_active: numOrNull(r.last_active),
  })));

  // 6-week journey heatmap (aggregated across all dept members)
  // Use cowork_messages.occurred_at (when the work happened) not classified_at
  const classifications = await client
    .select({ tier: pc.tier, occurred_at: cm.occurred_at })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .where(and(inArray(pc.user_id, memberIds), eq(pc.classifier_status, 'classified'), gte(cm.occurred_at, sixWeeksAgo)))
    .orderBy(cm.occurred_at);

  const heatmapMap = new Map<string, number>();
  for (const row of classifications) {
    const weekIndex = Math.min(5, Math.floor((now - row.occurred_at) / (7 * 24 * 3600)));
    const displayWeek = weekIndex; // Wk 1 = most recent, Wk 6 = oldest
    const key = `${displayWeek}-${row.tier}`;
    heatmapMap.set(key, (heatmapMap.get(key) ?? 0) + 1);
  }
  const journeyHeatmap = Array.from(heatmapMap.entries()).map(([key, count]) => {
    const [week, tier] = key.split('-').map(Number);
    return { week, tier, count };
  });

  // Concentration risk: Tier 3 task types run by only one member in past 2 weeks
  const tier3ByType = await client
    .select({ user_id: pc.user_id, task_type: pc.task_type, cnt: sql<number | string>`COUNT(*)` })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .where(and(inArray(pc.user_id, memberIds), eq(pc.tier, 3), eq(pc.classifier_status, 'classified'), gte(cm.occurred_at, twoWeeksAgo)))
    .groupBy(pc.user_id, pc.task_type);

  const typeUsersMap = new Map<string, Set<string>>();
  for (const row of tier3ByType) {
    const set = typeUsersMap.get(row.task_type) ?? new Set();
    set.add(row.user_id);
    typeUsersMap.set(row.task_type, set);
  }

  const soleWorkflowCounts = new Map<string, number>();
  const soleWorkflowTypes = new Map<string, string[]>(); // user_id → sole task_types
  for (const [taskType, users] of typeUsersMap) {
    if (users.size === 1) {
      const uid = [...users][0];
      soleWorkflowCounts.set(uid, (soleWorkflowCounts.get(uid) ?? 0) + 1);
      const types = soleWorkflowTypes.get(uid) ?? [];
      types.push(taskType);
      soleWorkflowTypes.set(uid, types);
    }
  }

  const concentrationRisk: Array<{
    user_id: string; display_name: string | null; sole_workflows: number;
  }> = [];
  const concentrationDetail: Array<{
    user_id: string; display_name: string | null; task_types: string[];
  }> = [];

  for (const [uid, count] of soleWorkflowCounts) {
    if (count >= 1) {
      const member = members.find(m => m.id === uid);
      const displayName = member?.display_name ?? member?.email ?? uid;
      if (count >= 3) {
        concentrationRisk.push({ user_id: uid, display_name: displayName, sole_workflows: count });
      }
      concentrationDetail.push({
        user_id: uid,
        display_name: displayName,
        task_types: soleWorkflowTypes.get(uid) ?? [],
      });
    }
  }

  // Skill concentration: skills used by only one member in past 30 days
  const thirtyDaysAgo = now - 30 * 24 * 3600;
  const skillInvocationRows = await client
    .select({ user_id: csi.user_id, skill_name: csi.skill_name })
    .from(csi)
    .where(and(inArray(csi.user_id, memberIds), gte(csi.occurred_at, thirtyDaysAgo)))
    .groupBy(csi.user_id, csi.skill_name);

  const skillUsersMap = new Map<string, Set<string>>();
  for (const row of skillInvocationRows) {
    const set = skillUsersMap.get(row.skill_name) ?? new Set();
    set.add(row.user_id);
    skillUsersMap.set(row.skill_name, set);
  }

  const skillConcentration: Array<{
    user_id: string; display_name: string | null; skills: string[];
  }> = [];
  const soleSkillsByUser = new Map<string, string[]>();
  for (const [skillName, users] of skillUsersMap) {
    if (users.size === 1) {
      const uid = [...users][0];
      const arr = soleSkillsByUser.get(uid) ?? [];
      arr.push(skillName);
      soleSkillsByUser.set(uid, arr);
    }
  }
  for (const [uid, skills] of soleSkillsByUser) {
    const member = members.find(m => m.id === uid);
    skillConcentration.push({
      user_id: uid,
      display_name: member?.display_name ?? member?.email ?? uid,
      skills,
    });
  }

  // Tools used — skills and connectors across dept members in last 7 days
  const sevenDaysAgoTools = now - 7 * 24 * 3600;
  const deptSkillsRows = await client
    .select({ name: csi.skill_name, cnt: sql<number | string>`COUNT(*)` })
    .from(csi)
    .where(and(inArray(csi.user_id, memberIds), gte(csi.occurred_at, sevenDaysAgoTools)))
    .groupBy(csi.skill_name);
  const deptSkills = deptSkillsRows.map(r => ({ name: r.name, cnt: Number(r.cnt) }));

  const deptConnectorsRows = await client
    .select({ name: cmi.mcp_server, cnt: sql<number | string>`COUNT(*)` })
    .from(cmi)
    .where(and(
      inArray(cmi.user_id, memberIds),
      gte(cmi.occurred_at, sevenDaysAgoTools),
      notInArray(cmi.mcp_server, ['workspace', 'cowork']),
    ))
    .groupBy(cmi.mcp_server);
  const deptConnectors = deptConnectorsRows.map(r => ({ name: r.name, cnt: Number(r.cnt) }));

  const deptToolsUsed = [
    ...deptSkills.map(r => ({ name: r.name, type: 'skill' as const, count: r.cnt })),
    ...deptConnectors.map(r => ({ name: r.name, type: 'connector' as const, count: r.cnt })),
  ].sort((a, b) => b.count - a.count);

  // Frontier boxes + feed. Own try/catch so a failure hides
  // the boxes, not the page.
  let frontier = null;
  try {
    frontier = await buildFrontierView({ dept }, now, {
      seeAllDetail: canAccessPulseAdmin(session.role),
      ownUserId: await resolveViewerUserId(session.email),
    });
  } catch (err) {
    console.error('[pulse/dept] frontier view failed', err);
  }

  const deptBriefingRows = await client
    .select({ body: pb.body, suggestion: pb.suggestion, generated_at: pb.generated_at })
    .from(pb)
    .where(and(eq(pb.scope_type, 'function'), eq(pb.scope_id, dept)))
    .orderBy(desc(pb.generated_at))
    .limit(1);
  const deptBriefing = deptBriefingRows[0];

  // Document-upload sessions for dept members (30 days)
  const deptDocSessionRows = await client
    .select({
      sessions_with_uploads: sql<number | string>`COUNT(*)`,
      total_uploads: sql<number | string>`COALESCE(SUM(${css.upload_count}), 0)`,
    })
    .from(css)
    .innerJoin(cs, eq(cs.id, css.session_id))
    .where(and(gt(css.upload_count, 0), gte(cs.started_at, thirtyDaysAgo), inArray(cs.user_id, memberIds)));
  const docSessions = {
    sessions_with_uploads: Number(deptDocSessionRows[0]?.sessions_with_uploads ?? 0),
    total_uploads: Number(deptDocSessionRows[0]?.total_uploads ?? 0),
  };

  // OTel cowork enrichments — sum cost and aggregate friction across dept members
  const sevenDaysAgoOtel = now - 7 * 24 * 3600;
  let deptCoworkCostUsd = 0;
  let deptFailedTools = 0;
  let deptTotalTools = 0;
  for (const memberId of memberIds) {
    deptCoworkCostUsd += await getCoworkCostUsd(memberId, sevenDaysAgoOtel, now);
    const fiRows = await client
      .select({
        failed_tools: sql<number | string>`COUNT(*) FILTER (WHERE ${cm.tool_success} = 0)`,
        total_tools: sql<number | string>`COUNT(*) FILTER (WHERE ${cm.message_type} = 'cowork_tool_metadata')`,
      })
      .from(cm)
      .where(and(eq(cm.user_id, memberId), gte(cm.occurred_at, sevenDaysAgoOtel), lte(cm.occurred_at, now)));
    deptFailedTools += Number(fiRows[0]?.failed_tools ?? 0);
    deptTotalTools += Number(fiRows[0]?.total_tools ?? 0);
  }
  const deptCoworkFrictionIndex = deptTotalTools > 0
    ? deptFailedTools / deptTotalTools
    : null;

  // ── Delegation view ───────────────────────────────────────────────────────
  const weeksParamRaw = Number(request.nextUrl.searchParams.get('weeks'));
  const delegationWindow = ([13, 26, 52] as const).includes(weeksParamRaw as 13 | 26 | 52)
    ? (weeksParamRaw as 13 | 26 | 52) : 26;
  const delegationWeeks = weekStarts(now, delegationWindow + 1).slice(0, delegationWindow);

  // A rubric save never splits the delegation charts or restarts then-vs-now:
  // admins update the tiers often, and splitting on each save would blank the
  // department arrows for four weeks. Saves are still logged in
  // pulse_rubric_versions; they do not segment the charts.
  const rubricChangesAtS: number[] = [];

  // Department bands (function scope; no per-week event floor).
  const deptWeekRowsRaw = await client
    .select({
      scope_id: pm.scope_id, period_start: pm.period_start,
      t1: pm.tier_1_count, t2: pm.tier_2_count, t3: pm.tier_3_count,
    })
    .from(pm)
    .where(and(
      eq(pm.granularity, 'week'), eq(pm.scope_type, 'function'), eq(pm.scope_id, dept),
      gte(pm.period_start, delegationWeeks[0]), lt(pm.period_start, weekStart(now)),
    ));
  const deptWeekRows: DelegationWeekRow[] = deptWeekRowsRaw.map(r => ({
    scopeId: r.scope_id, periodStart: Number(r.period_start),
    t1: Number(r.t1), t2: Number(r.t2), t3: Number(r.t3),
  }));
  const bands = buildBandSegments(deptWeekRows, dept, delegationWeeks, rubricChangesAtS);
  const bandsDataWeeks = countDataWeeks(
    buildDepthSegments(deptWeekRows, dept, delegationWeeks, rubricChangesAtS, 0));

  // Per-person series (user scope; MIN_WEEK_EVENTS floor applies).
  const personRowsRaw = memberIds.length === 0 ? [] : await client
    .select({
      scope_id: pm.scope_id, period_start: pm.period_start,
      t1: pm.tier_1_count, t2: pm.tier_2_count, t3: pm.tier_3_count,
    })
    .from(pm)
    .where(and(
      eq(pm.granularity, 'week'), eq(pm.scope_type, 'user'), inArray(pm.scope_id, memberIds),
      gte(pm.period_start, delegationWeeks[0]), lt(pm.period_start, weekStart(now)),
    ));
  const personRows: DelegationWeekRow[] = personRowsRaw.map(r => ({
    scopeId: r.scope_id, periodStart: Number(r.period_start),
    t1: Number(r.t1), t2: Number(r.t2), t3: Number(r.t3),
  }));

  // Sort by the latest segment's delta, tri-state (no NaN): both null → tied,
  // a null always sorts after a real value, then descending by deltaPp.
  // People sort ALPHABETICALLY: improvement-first
  // ordering turned the list into a per-person leaderboard whose bottom row
  // reads as "least improved". Departments on the CIO overview keep
  // improvement-first — ranking teams is the point there; ranking named
  // individuals is not.

  const people = memberIds.flatMap((userId) => {
    const segments = buildDepthSegments(personRows, userId, delegationWeeks, rubricChangesAtS);
    // Omit gate stays on ALL-segments data — a person with only pre-rubric
    // history should still appear (their latest-segment count may be 0).
    if (countDataWeeks(segments) === 0) return [];
    // Insert a gap between segments so a rubric break renders as a break in
    // the sparkline too, not a continuous run of incomparable bars.
    const sparkline = segments.flatMap((s, i) =>
      i === 0 ? s.points.map(p => p.depth) : [null, ...s.points.map(p => p.depth)]);
    return [{
      userId,
      displayName: displayNameById.get(userId) ?? userId,
      sparkline,
      thenVsNow: buildThenVsNow(segments),
      // dataWeeks reflects the LATEST segment only — the same segment
      // thenVsNow judges — so the UI never contradicts itself after a
      // rubric edit (see countLatestSegmentDataWeeks doc comment).
      dataWeeks: countLatestSegmentDataWeeks(segments),
    }];
  }).sort((a, b) => a.displayName.localeCompare(b.displayName));

  // Coaching prompts — getDeptCoachingPrompts itself
  // checks useCasesEnabled first and returns [] without touching the
  // DB when the flag is off, mirroring lib/digest/build.ts's idiom — so
  // this call is safe unconditionally, same as every other caller.
  const coachingPrompts = await getDeptCoachingPrompts(dept, now);

  const humanTime = await readHumanTime('cowork', memberIds);

  return NextResponse.json({
    humanTime,
    dept,
    members,
    memberMetrics,
    metrics: metrics ?? null,
    priorMetrics: priorMetrics ?? null,
    teamMetrics: {
      psr: deptPsr, ors: deptOrs,
      orsBreadth: deptOrsBreadth, orsOverlap: deptOrsOverlap, orsPropagation: deptOrsPropagation,
    },
    journeyHeatmap,
    concentrationRisk,
    concentrationDetail,
    skillConcentration,
    frontier,
    frontierAccess: { canReview: session.role === 'admin', canOpenUseCases: canAccessPulseAdmin(session.role) },
    toolsUsed: deptToolsUsed,
    deptBriefing: deptBriefing ?? null,
    coworkCostUsd: deptCoworkCostUsd,
    coworkFrictionIndex: deptCoworkFrictionIndex,
    docSessions,
    delegation: { window: delegationWindow, bands, bandsDataWeeks, people },
    coaching: { prompts: coachingPrompts },
  });
}
