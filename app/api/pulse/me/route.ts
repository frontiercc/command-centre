// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table> for
// plain selects (Number()-safe since Drizzle's own column codecs decode
// integer/doublePrecision/bigint({mode:'number'}) correctly),
// and a local rawAll()/rawGet() facade for the NOT-IN-subquery / GROUP BY
// analytic reads (mirrors lib/pulse/classifier.ts + lib/db/queries.ts). Every
// raw-SQL COUNT/SUM aggregate is Number()-coerced (bigint/numeric
// come back as STRINGS on Postgres).
import { NextRequest, NextResponse } from 'next/server';
import { and, asc, desc, eq, gte, isNotNull, lte, ne, sql } from 'drizzle-orm';
import { getAdminSession, isDeptScoped, canAccessCoworkPulse, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { buildFrontierView, resolveViewerUserId } from '@/lib/pulse/frontier-view';
import { promptTextVisibleFor, logPromptRead } from '@/lib/auth/content-access';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getCoworkCostUsd, getCoworkFrictionIndex } from '@/lib/pulse/aggregator';
import { getPublishedAgreement } from '@/lib/pulse/audit/cycle';
import { readHumanTime } from '@/lib/pulse/human-time-summary';
import { getAllConfig } from '@/lib/config';
import { canViewSpendReview } from '@/lib/finance/spend-review-access';

// OTI's interpretive status line is gated on the classifier accuracy audit
// clearing its substantial-agreement floor. No scored audit yet, or below the
// floor → the status reads "under review" rather than asserting a verdict.
const KAPPA_FLOOR = 0.6;

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
async function rawGet<T>(client: unknown, query: unknown): Promise<T | undefined> {
  const rows = await rawAll<T>(client, query);
  return rows[0];
}

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessCoworkPulse(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const client = await getTypedClient();

  // Resolve the cowork user_id by matching admin_users.email → users.email
  // Admins can also pass ?userId= to view another user's data
  let userId: string | null = null;

  // Resolve "my" cowork user ID: check linked_cowork_user_id first, fall back to email match
  async function resolveMyUserId(): Promise<string | null> {
    const linkedRows = await client
      .select({ linked_cowork_user_id: schema.adminUsers.linked_cowork_user_id })
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.email, session.email!))
      .limit(1);
    if (linkedRows[0]?.linked_cowork_user_id) return linkedRows[0].linked_cowork_user_id;
    const byEmailRows = await client
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, session.email!))
      .limit(1);
    return byEmailRows[0]?.id ?? null;
  }

  const queryUserId = request.nextUrl.searchParams.get('userId');
  if (queryUserId) {
    if (session.role === 'admin' || session.role === 'manager') {
      userId = queryUserId;
    } else if (isDeptScoped(session.role) && session.department) {
      // Verify the requested user is in the same department
      const targetAdminRows = await client
        .select({ department: schema.adminUsers.department })
        .from(schema.adminUsers)
        .where(eq(schema.adminUsers.linked_cowork_user_id, queryUserId))
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
    // No cowork data for this user yet
    return NextResponse.json({
      userId: null,
      metrics: null,
      frontier: null,
      journeyGrid: [],
      weeklyPulse: null,
      skillExchange: [],
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const sixWeeksAgo = now - 42 * 24 * 3600;

  // Latest metrics for this user
  const metricsRows = await client
    .select({
      oti: schema.pulseMetrics.oti,
      dds: schema.pulseMetrics.dds,
      psr: schema.pulseMetrics.psr,
      ors: schema.pulseMetrics.ors,
      event_count: schema.pulseMetrics.event_count,
      tier_1_count: schema.pulseMetrics.tier_1_count,
      tier_2_count: schema.pulseMetrics.tier_2_count,
      tier_3_count: schema.pulseMetrics.tier_3_count,
      computed_at: schema.pulseMetrics.computed_at,
      // OTI v2: "Early read" badge provenance + formula version.
      oti_early_read: schema.pulseMetrics.oti_early_read,
      metric_version: schema.pulseMetrics.metric_version,
    })
    .from(schema.pulseMetrics)
    .where(and(
      eq(schema.pulseMetrics.scope_type, 'user'),
      eq(schema.pulseMetrics.scope_id, userId),
      eq(schema.pulseMetrics.granularity, 'rolling'),
    ))
    .orderBy(desc(schema.pulseMetrics.computed_at))
    .limit(1);
  const metrics = metricsRows[0];

  // Prior period metrics: row closest to 7 days ago for meaningful week-over-week delta
  const sevenDaysAgo = now - 7 * 24 * 3600;
  const priorMetricsRows = await client
    .select({
      oti: schema.pulseMetrics.oti,
      dds: schema.pulseMetrics.dds,
      psr: schema.pulseMetrics.psr,
      ors: schema.pulseMetrics.ors,
    })
    .from(schema.pulseMetrics)
    .where(and(
      eq(schema.pulseMetrics.scope_type, 'user'),
      eq(schema.pulseMetrics.scope_id, userId),
      eq(schema.pulseMetrics.granularity, 'rolling'),
      lte(schema.pulseMetrics.computed_at, sevenDaysAgo),
    ))
    .orderBy(desc(schema.pulseMetrics.computed_at))
    .limit(1);
  const priorMetrics = priorMetricsRows[0];

  // 6-week journey grid: group classifications by week number and tier
  // Use cowork_messages.occurred_at (when the work happened) not classified_at
  // (when the AI ran — batch classification skews everything to the same week)
  const classifications = await client
    .select({
      tier: schema.pulseClassifications.tier,
      task_type: schema.pulseClassifications.task_type,
      occurred_at: schema.coworkMessages.occurred_at,
    })
    .from(schema.pulseClassifications)
    .innerJoin(schema.coworkMessages, eq(schema.coworkMessages.id, schema.pulseClassifications.cowork_message_id))
    .where(and(
      eq(schema.pulseClassifications.user_id, userId),
      eq(schema.pulseClassifications.classifier_status, 'classified'),
      gte(schema.coworkMessages.occurred_at, sixWeeksAgo),
    ))
    .orderBy(asc(schema.coworkMessages.occurred_at));

  // Build grid: array of { weekIndex: 0-5, tier: 1|2|3, count }
  const gridMap = new Map<string, number>();
  for (const row of classifications) {
    const weekIndex = Math.min(5, Math.floor((now - row.occurred_at) / (7 * 24 * 3600)));
    // Wk 1 = most recent, Wk 6 = oldest
    const displayWeek = weekIndex;
    const key = `${displayWeek}-${row.tier}`;
    gridMap.set(key, (gridMap.get(key) ?? 0) + 1);
  }
  const journeyGrid = Array.from(gridMap.entries()).map(([key, count]) => {
    const [week, tier] = key.split('-').map(Number);
    return { week, tier, count };
  });

  // Weekly pulse briefing
  const weeklyPulseRows = await client
    .select({
      body: schema.pulseBriefings.body,
      suggestion: schema.pulseBriefings.suggestion,
      generated_at: schema.pulseBriefings.generated_at,
    })
    .from(schema.pulseBriefings)
    .where(and(eq(schema.pulseBriefings.scope_type, 'user'), eq(schema.pulseBriefings.scope_id, userId)))
    .orderBy(desc(schema.pulseBriefings.generated_at))
    .limit(1);
  const weeklyPulse = weeklyPulseRows[0];

  // User info for display and back-link
  const userRows = await client
    .select({ team_id: schema.users.team_id, display_name: schema.users.display_name, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const userRow = userRows[0];

  const teamId = userRow?.team_id ?? null;

  // Department comes from the admin account linked to this cowork user (Access & Keys page)
  const adminRows = await client
    .select({ department: schema.adminUsers.department })
    .from(schema.adminUsers)
    .where(eq(schema.adminUsers.linked_cowork_user_id, userId))
    .limit(1);
  const department = adminRows[0]?.department ?? null;
  const displayName = userRow?.display_name ?? userRow?.email ?? null;

  // ORS: prefer dept-level (scope_type='function') but always fall back to team-level
  // if dept ORS is null. The aggregator writes ORS at both scopes, but users.team_id
  // is never populated in any real deployment (no admin UI, no ingest default), so
  // 'team' rows never actually exist there — dept-level is what real data lands in.
  const deptOrsRows = department ? await client
    .select({ ors: schema.pulseMetrics.ors })
    .from(schema.pulseMetrics)
    .where(and(
      eq(schema.pulseMetrics.scope_type, 'function'),
      eq(schema.pulseMetrics.scope_id, department),
      eq(schema.pulseMetrics.granularity, 'rolling'),
    ))
    .orderBy(desc(schema.pulseMetrics.computed_at))
    .limit(1) : [];
  const teamOrsRows = teamId ? await client
    .select({ ors: schema.pulseMetrics.ors })
    .from(schema.pulseMetrics)
    .where(and(
      eq(schema.pulseMetrics.scope_type, 'team'),
      eq(schema.pulseMetrics.scope_id, teamId),
      eq(schema.pulseMetrics.granularity, 'rolling'),
    ))
    .orderBy(desc(schema.pulseMetrics.computed_at))
    .limit(1) : [];
  const teamOrs = deptOrsRows[0]?.ors ?? teamOrsRows[0]?.ors ?? null;

  let skillExchange: Array<{
    skill_name: string; description: string | null;
    author_user_id: string | null; run_count: number;
  }> = [];

  if (teamId) {
    skillExchange = await client
      .select({
        skill_name: schema.pulseSkills.skill_name,
        description: schema.pulseSkills.description,
        author_user_id: schema.pulseSkills.author_user_id,
        run_count: schema.pulseSkills.run_count,
      })
      .from(schema.pulseSkills)
      .where(eq(schema.pulseSkills.team_id, teamId))
      .orderBy(desc(schema.pulseSkills.run_count))
      .limit(20);
  }

  // Unclassified messages for this user (pending classification). NOT-IN
  // subquery kept as one raw statement.
  const pendingRow = await rawGet<{ cnt: number | string }>(client, sql`
    SELECT COUNT(*) as cnt FROM cowork_messages cm
    WHERE cm.surface = 'cowork' AND cm.user_id = ${userId}
      AND cm.message_type = 'cowork_user_message'
      AND cm.id NOT IN (
        SELECT cowork_message_id FROM pulse_classifications
        WHERE classifier_status = 'classified' OR classifier_attempts >= 5
      )
  `);
  const pendingClassifications = Number(pendingRow?.cnt ?? 0);

  // Capabilities Created — confirmed capability_creation events for this user
  const confirmedCapabilitiesRows = await client
    .select({ cnt: sql<number | string>`COUNT(*)` })
    .from(schema.pulseEvents)
    .where(and(
      eq(schema.pulseEvents.user_id, userId),
      eq(schema.pulseEvents.event_type, 'capability_creation'),
      eq(schema.pulseEvents.status, 'confirmed'),
    ));
  const confirmedCapabilitiesCount = Number(confirmedCapabilitiesRows[0]?.cnt ?? 0);

  const confirmedList = await client
    .select({
      title: schema.pulseEvents.title,
      detected_at: schema.pulseEvents.detected_at,
      confirmed_at: schema.pulseEvents.confirmed_at,
      tier: schema.pulseEvents.tier,
    })
    .from(schema.pulseEvents)
    .where(and(
      eq(schema.pulseEvents.user_id, userId),
      eq(schema.pulseEvents.event_type, 'capability_creation'),
      eq(schema.pulseEvents.status, 'confirmed'),
    ))
    .orderBy(desc(schema.pulseEvents.confirmed_at))
    .limit(20);

  const pendingCandidates = await client
    .select({
      id: schema.pulseEvents.id,
      title: schema.pulseEvents.title,
      body: schema.pulseEvents.body,
      tier: schema.pulseEvents.tier,
      detected_at: schema.pulseEvents.detected_at,
    })
    .from(schema.pulseEvents)
    .where(and(
      eq(schema.pulseEvents.user_id, userId),
      eq(schema.pulseEvents.event_type, 'capability_creation'),
      eq(schema.pulseEvents.status, 'candidate'),
    ))
    .orderBy(desc(schema.pulseEvents.detected_at))
    .limit(10);

  // A candidate's body quotes up to 300 characters of the person's prompt.
  // The person sees their own; anyone else only under the Audit Log rule
  // (admin, or manager in the person's department). A same-department
  // colleague still sees the titles.
  const isSelf = userId === (await resolveMyUserId());
  const otherSeesPrompt = !isSelf && pendingCandidates.length > 0
    && (await promptTextVisibleFor(session, [userId])).has(userId);
  if (otherSeesPrompt) await logPromptRead(request, session, 'pulse/me/capability-candidates');
  const capabilitiesDetail = {
    count: confirmedCapabilitiesCount,
    confirmed: confirmedList,
    pending: isSelf || otherSeesPrompt ? pendingCandidates : pendingCandidates.map(c => ({ ...c, body: null })),
  };

  // Skills and connectors used in the last 7 days
  const sevenDaysAgoTools = now - 7 * 24 * 3600;
  const skillsUsedRaw = await rawAll<{ name: string; cnt: number | string }>(client, sql`
    SELECT skill_name AS name, COUNT(*) AS cnt
    FROM cowork_skill_invocations
    WHERE user_id = ${userId} AND occurred_at >= ${sevenDaysAgoTools}
    GROUP BY skill_name
  `);
  const skillsUsed = skillsUsedRaw.map(r => ({ name: r.name, cnt: Number(r.cnt) }));

  const connectorsUsedRaw = await rawAll<{ name: string; cnt: number | string }>(client, sql`
    SELECT mcp_server AS name, COUNT(*) AS cnt
    FROM cowork_mcp_invocations
    WHERE user_id = ${userId} AND occurred_at >= ${sevenDaysAgoTools}
      AND mcp_server NOT IN ('workspace', 'cowork', 'Claude_in_Chrome')
    GROUP BY mcp_server
  `);
  const connectorsUsed = connectorsUsedRaw.map(r => ({ name: r.name, cnt: Number(r.cnt) }));

  const toolsUsed: Array<{ name: string; type: 'skill' | 'connector'; count: number }> = [
    ...skillsUsed.map(r => ({ name: r.name, type: 'skill' as const, count: r.cnt })),
    ...connectorsUsed.map(r => ({ name: r.name, type: 'connector' as const, count: r.cnt })),
  ].sort((a, b) => b.count - a.count);

  // Top native tools from OTel session stats — 30-day window, aggregate JSON arrays in JS
  const thirtyDaysAgo = now - 30 * 24 * 3600;
  const userNativeToolRows = await client
    .select({ unique_tools: schema.coworkSessionStats.unique_tools })
    .from(schema.coworkSessionStats)
    .innerJoin(schema.coworkSessions, eq(schema.coworkSessions.id, schema.coworkSessionStats.session_id))
    .where(and(
      eq(schema.coworkSessions.user_id, userId),
      isNotNull(schema.coworkSessionStats.unique_tools),
      ne(schema.coworkSessionStats.unique_tools, '[]'),
      gte(schema.coworkSessions.started_at, thirtyDaysAgo),
    ));

  const userToolCounts = new Map<string, number>();
  for (const row of userNativeToolRows) {
    let tools: string[] = [];
    try { tools = JSON.parse(row.unique_tools ?? '[]') as string[]; } catch { continue; }
    for (const t of tools) userToolCounts.set(t, (userToolCounts.get(t) ?? 0) + 1);
  }
  const topNativeTools = Array.from(userToolCounts.entries())
    .map(([tool_name, usage_count]) => ({ tool_name, usage_count }))
    .sort((a, b) => b.usage_count - a.usage_count)
    .slice(0, 5);

  // OTel cowork enrichments — 7-day window
  const sevenDaysAgoOtel = now - 7 * 24 * 3600;
  const coworkCostUsd = await getCoworkCostUsd(userId, sevenDaysAgoOtel, now);
  const coworkFrictionIndex = await getCoworkFrictionIndex(userId, sevenDaysAgoOtel, now);

  // Frontier boxes: best recent work, step-ups, capabilities.
  // Own try/catch so a failure hides the boxes, not the page.
  let frontier = null;
  try {
    frontier = await buildFrontierView({ userId }, now, {
      seeAllDetail: canAccessPulseAdmin(session.role),
      ownUserId: await resolveViewerUserId(session.email),
    });
  } catch (err) {
    console.error('[pulse/me] frontier view failed', err);
  }

  // Gate: OTI status copy stays "under review" until the audit clears the floor.
  const published = await getPublishedAgreement('cowork');
  const otiUnderReview = published === null || published.kappa < KAPPA_FLOOR;

  // Person-level human time: admins and managers for anyone, everyone else for
  // themselves only (a same-department colleague's page does not carry it).
  const seesPerson = canAccessPulseAdmin(session.role) || userId === (await resolveMyUserId());
  const humanTime = seesPerson ? await readHumanTime('cowork', [userId]) : null;
  // Link to this person's Spend Review, for whoever may open it
  // (lib/finance/spend-review-access.ts); it lives under FinOps and is hidden with it.
  const canSeeSpendReview = (await getAllConfig()).chargebackEnabled === true
    && await canViewSpendReview(session, userId);

  return NextResponse.json({
    humanTime,
    canSeeSpendReview,
    userId,
    displayName,
    department,
    metrics: metrics ?? null,
    priorMetrics: priorMetrics ?? null,
    frontier,
    frontierAccess: { canReview: session.role === 'admin', canOpenUseCases: canAccessPulseAdmin(session.role) },
    journeyGrid,
    pendingClassifications,
    weeklyPulse: weeklyPulse ?? null,
    skillExchange,
    capabilitiesDetail,
    teamId,
    teamMetrics: { ors: teamOrs },
    toolsUsed,
    coworkCostUsd,
    coworkFrictionIndex,
    topNativeTools,
    otiUnderReview,
  });
}
