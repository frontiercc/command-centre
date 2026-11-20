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
import { getTierNames } from '@/lib/pulse/tier-config';
import { visibleVendor, visibleOpenAi } from '@/lib/sources/openai-visibility';
import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { getAdminSession, isDeptScoped, canAccessCoworkPulse, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { buildFrontierView, resolveViewerUserId } from '@/lib/pulse/frontier-view';
import { promptTextVisibleFor, logPromptRead } from '@/lib/auth/content-access';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getCoworkFrictionIndex } from '@/lib/pulse/aggregator';
import { hasOpenAiData } from '@/lib/dashboard/queries';
import { vendorClause } from '@/lib/dashboard/product-sql';
import { getPublishedAgreement } from '@/lib/pulse/audit/cycle';
import { readHumanTime } from '@/lib/pulse/human-time-summary';
import { getAllConfig } from '@/lib/config';
import { canViewSpendReview } from '@/lib/finance/spend-review-access';
import { isWorkPulseSurface, classifiableSource, classifyChatgptOn } from '@/lib/pulse/work-surfaces';
import { buildMyPeriod, type MyPeriod, type PulsePeriod } from '@/lib/pulse/my-period';
import { humanTimeOn } from '@/lib/pulse/human-time-flags';
import { monthSpend } from '@/lib/finance/month-spend';

// OTI's interpretive status line is gated on the classifier accuracy audit
// clearing its substantial-agreement floor. No scored audit yet, or below the
// floor → the status reads "under review" rather than asserting a verdict.
const KAPPA_FLOOR = 0.6;

import { keptFigures } from '@/lib/kept-figures';
import { errorResponse } from '@/lib/api/errors';

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
      // Verify the requested user is in the same department: their sign-in account's department,
      // else their own record's (as Person 360 and the Users list do), so a colleague with no
      // sign-in account can be opened too.
      const targetAdminRows = await client
        .select({ department: schema.adminUsers.department })
        .from(schema.adminUsers)
        .where(eq(schema.adminUsers.linked_cowork_user_id, queryUserId))
        .limit(1);
      const targetUserRows = targetAdminRows[0] ? [] : await client
        .select({ department: schema.users.department })
        .from(schema.users)
        .where(eq(schema.users.id, queryUserId))
        .limit(1);
      if ((targetAdminRows[0]?.department ?? targetUserRows[0]?.department ?? null) === session.department) {
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
      weeklyPulse: null,
    });
  }

  try {
    const sp = request.nextUrl.searchParams;
    // Kept per person, view, period and viewer for five minutes (lib/kept-figures.ts):
    // what a viewer may see of someone (spend, by-hand time, best work) depends on who they are.
    // ?fresh=1 after an action on the page. A result with a part that failed is not kept.
    const key = ['me', userId, sp.get('vendor') ?? '', sp.get('period') ?? '', session.role ?? '', session.email ?? ''].join('\u0000');
    const forUser = userId;
    const { promptRead, ...body } = await keptFigures(key, () => buildMe(sp, session, forUser, resolveMyUserId), { keep: b => b.failed.length === 0, force: sp.get('fresh') === '1' });
    // Every visit that shows someone else's prompt text is recorded, whether kept or built.
    if (promptRead) await logPromptRead(request, session, 'pulse/me/capability-candidates');
    return NextResponse.json(body);
  } catch (err) {
    return errorResponse('pulse/me', err);
  }
}

async function buildMe(
  searchParams: URLSearchParams,
  session: Awaited<ReturnType<typeof getAdminSession>>,
  userId: string,
  resolveMyUserId: () => Promise<string | null>,
) {
  const client = await getTypedClient();
  const now = Math.floor(Date.now() / 1000);

  // The Claude / OpenAI switch: a vendor view reads the aggregator's per-vendor
  // figures and narrows classifications, skills and connectors by source.
  const vendor = await visibleVendor(searchParams.get('vendor'));
  const pmv = schema.pulseMetricsVendor;
  const pm = vendor === 'all' ? schema.pulseMetrics : pmv as unknown as typeof schema.pulseMetrics;
  const pmOnly = vendor === 'all' ? sql`TRUE` : eq(pmv.vendor, vendor);

  // Latest metrics for this user
  const metricsRows = await client
    .select({
      oti: pm.oti,
      dds: pm.dds,
      psr: pm.psr,
      ors: pm.ors,
      event_count: pm.event_count,
      tier_1_count: pm.tier_1_count,
      tier_2_count: pm.tier_2_count,
      tier_3_count: pm.tier_3_count,
      computed_at: pm.computed_at,
      // OTI v2: "Early read" badge provenance + formula version.
      oti_early_read: pm.oti_early_read,
      metric_version: pm.metric_version,
    })
    .from(pm)
    .where(and(
      pmOnly,
      eq(pm.scope_type, 'user'),
      eq(pm.scope_id, userId),
      eq(pm.granularity, 'rolling'),
    ))
    .orderBy(desc(pm.computed_at))
    .limit(1);
  const metrics = metricsRows[0];

  // Prior period metrics: row closest to 7 days ago for meaningful week-over-week delta
  const sevenDaysAgo = now - 7 * 24 * 3600;
  const priorMetricsRows = await client
    .select({
      oti: pm.oti,
      dds: pm.dds,
      psr: pm.psr,
      ors: pm.ors,
    })
    .from(pm)
    .where(and(
      pmOnly,
      eq(pm.scope_type, 'user'),
      eq(pm.scope_id, userId),
      eq(pm.granularity, 'rolling'),
      lte(pm.computed_at, sevenDaysAgo),
    ))
    .orderBy(desc(pm.computed_at))
    .limit(1);
  const priorMetrics = priorMetricsRows[0];

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
    .select({ ors: pm.ors })
    .from(pm)
    .where(and(
      pmOnly,
      eq(pm.scope_type, 'function'),
      eq(pm.scope_id, department),
      eq(pm.granularity, 'rolling'),
    ))
    .orderBy(desc(pm.computed_at))
    .limit(1) : [];
  const teamOrsRows = teamId ? await client
    .select({ ors: pm.ors })
    .from(pm)
    .where(and(
      pmOnly,
      eq(pm.scope_type, 'team'),
      eq(pm.scope_id, teamId),
      eq(pm.granularity, 'rolling'),
    ))
    .orderBy(desc(pm.computed_at))
    .limit(1) : [];
  const teamOrs = deptOrsRows[0]?.ors ?? teamOrsRows[0]?.ors ?? null;

  // Unclassified messages for this user (pending classification). NOT-IN
  // subquery kept as one raw statement.
  const pendingRow = await rawGet<{ cnt: number | string }>(client, sql`
    SELECT COUNT(*) as cnt FROM cowork_messages cm
    WHERE ${isWorkPulseSurface(sql`cm.surface`)} AND cm.user_id = ${userId}
      AND cm.message_type = 'cowork_user_message'
      AND ${sql.raw(vendorClause(vendor, 'cm.'))}
      AND ${classifiableSource(sql`cm.source`, await classifyChatgptOn())}
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
  // Recorded by the request on every visit, whether the figures were kept or built.
  const capabilitiesDetail = {
    count: confirmedCapabilitiesCount,
    confirmed: confirmedList,
    pending: isSelf || otherSeesPrompt ? pendingCandidates : pendingCandidates.map(c => ({ ...c, body: null })),
  };

  // OTel cowork enrichments — 7-day window
  const sevenDaysAgoOtel = now - 7 * 24 * 3600;
  const openaiPresent = await visibleOpenAi(hasOpenAiData());
  const coworkFrictionIndex = await getCoworkFrictionIndex(userId, sevenDaysAgoOtel, now);

  // Frontier boxes: best recent work, step-ups, capabilities.
  // Own try/catch so a failure hides the boxes, not the page.
  // Parts that failed to build: their panels say they couldn't load, never look empty.
  const failed: string[] = [];
  let frontier = null;
  try {
    frontier = await buildFrontierView({ userId }, now, {
      seeAllDetail: canAccessPulseAdmin(session.role),
      ownUserId: await resolveViewerUserId(session.email),
    }, vendor);
  } catch (err) {
    console.error('[pulse/me] frontier view failed', err);
    failed.push('frontier');
  }

  // Gate: OTI status copy stays "under review" until the audit clears the floor.
  const published = await getPublishedAgreement('cowork');
  const otiUnderReview = published === null || published.kappa < KAPPA_FLOOR;

  // Person-level human time: admins and managers for anyone, everyone else for
  // themselves only (a same-department colleague's page does not carry it).
  const seesPerson = canAccessPulseAdmin(session.role) || userId === (await resolveMyUserId());
  const humanTime = seesPerson ? await readHumanTime('cowork', [userId], vendor) : null;
  // Link to this person's Spend Review, for whoever may open it
  // (lib/finance/spend-review-access.ts); it lives under FinOps and is hidden with it.
  const canSeeSpendReview = (await getAllConfig()).chargebackEnabled === true
    && await canViewSpendReview(session, userId);

  // The page's one period: this week, this month or this quarter. Own try/catch so a failure
  // hides the panels, not the page.
  const asked = searchParams.get('period');
  const period: PulsePeriod = asked === 'week' || asked === 'month' || asked === 'quarter' ? asked : 'quarter';
  let periodData: MyPeriod | null = null;
  try {
    periodData = await buildMyPeriod({ userId, department, vendor, nowS: now, period, showHumanTime: seesPerson, humanTimeOn: await humanTimeOn('cowork') });
  } catch (err) {
    console.error('[pulse/me] period failed', err);
    failed.push('period');
  }
  // A person's spend: admins and managers for anyone, everyone else only their own.
  let spendThisMonth: Awaited<ReturnType<typeof monthSpend>> | null = null;
  try {
    if (seesPerson) spendThisMonth = await monthSpend([userId], vendor, now);
  } catch (err) {
    console.error('[pulse/me] month spend failed', err);
    failed.push('spend');
  }

  return {
    promptRead: otherSeesPrompt,
    failed,
    tierNames: await getTierNames(),
    humanTime,
    period: periodData,
    spendThisMonth,
    canSeeSpendReview,
    userId,
    displayName,
    department,
    metrics: metrics ?? null,
    priorMetrics: priorMetrics ?? null,
    frontier,
    frontierAccess: { canReview: session.role === 'admin', canOpenUseCases: canAccessPulseAdmin(session.role) },
    pendingClassifications,
    weeklyPulse: weeklyPulse ?? null,
    capabilitiesDetail,
    teamId,
    teamMetrics: { ors: teamOrs },
    coworkFrictionIndex: vendor === 'openai' ? undefined : coworkFrictionIndex,
    otiUnderReview,
    vendor,
    openaiPresent,
  };
}
