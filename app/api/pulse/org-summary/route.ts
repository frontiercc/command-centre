// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table> for
// plain selects, and a local rawAll() facade for GROUP BY / analytic reads
// (mirrors lib/pulse/aggregator.ts + lib/db/queries.ts). Every raw-SQL
// COUNT/SUM/AVG aggregate is Number()-coerced (bigint/numeric come
// back as STRINGS on Postgres). otel_events.tool_input is jsonb on Postgres —
// its `decision` field is read with `->>'decision'`.
import { NextRequest, NextResponse } from 'next/server';
import { getTierNames } from '@/lib/pulse/tier-config';
import { visibleVendor } from '@/lib/sources/openai-visibility';
import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { weekStarts } from '@/lib/pulse/period';
import { getAdminSession, canAccessOrgOverview } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { buildSessionOutputRate, OUTPUT_RATE_WEEKS } from '@/lib/pulse/cowork/session-output-rate';
import { buildByProduct } from '@/lib/pulse/cowork/by-product';
import { getConnectedProducts, isOpenAiOnly } from '@/lib/sources/connected';
import { getConfigValue } from '@/lib/config';
import { readHumanTime } from '@/lib/pulse/human-time-summary';
import { vendorClause, workPulseToolClause, personPerProduct, vendorExpr } from '@/lib/dashboard/product-sql';
import { messageVendor } from '@/lib/pulse/vendor-filter';
import { isWorkPulseSurface } from '@/lib/pulse/work-surfaces';
import { orgSummaryWindow } from '@/lib/pulse/org-window';

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
  if (!canAccessOrgOverview(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const client = await getTypedClient();
  // The vendor switch narrows every figure here: the four signals read the
  // aggregator's per-vendor figures (pulse_metrics_vendor) in a vendor view.
  const vendor = await visibleVendor(request.nextUrl.searchParams.get('vendor'));
  const pm = schema.pulseMetrics;
  const pmv = schema.pulseMetricsVendor;
  const mt = vendor === 'all' ? pm : pmv as unknown as typeof pm;
  const mtOnly = vendor === 'all' ? sql`TRUE` : eq(pmv.vendor, vendor);
  // Skills and connectors: the ChatGPT view leaves Codex's out.
  const vendorSql = sql.raw(workPulseToolClause(vendor, 'cm.'));
  const now = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = now - 7 * 24 * 3600;
  const thirtyDaysAgo = now - 30 * 24 * 3600;

  // Org-level signal averages from latest pulse_metrics snapshots
  const ddsRows = await client
    .select({ v: sql<number | string | null>`AVG(${mt.dds})` })
    .from(mt)
    .where(and(
      mtOnly,
      eq(mt.scope_type, 'user'),
      isNotNull(mt.dds),
      eq(mt.granularity, 'rolling'),
      gte(mt.computed_at, sevenDaysAgo),
    ));
  const ddsAvg = ddsRows[0]?.v;

  const otiRows = await client
    .select({ v: sql<number | string | null>`AVG(${mt.oti})` })
    .from(mt)
    .where(and(
      mtOnly,
      eq(mt.scope_type, 'user'),
      isNotNull(mt.oti),
      eq(mt.granularity, 'rolling'),
      gte(mt.computed_at, sevenDaysAgo),
    ));
  const otiAvg = otiRows[0]?.v;

  // Confirmed capabilities; in a vendor view, those detected on that vendor's prompts.
  const psrRows = await client
    .select({ v: sql<number | string>`COUNT(*)` })
    .from(schema.pulseEvents)
    .leftJoin(schema.coworkMessages, eq(schema.coworkMessages.id, schema.pulseEvents.cowork_message_id))
    .where(and(eq(schema.pulseEvents.event_type, 'capability_creation'), eq(schema.pulseEvents.status, 'confirmed'),
      vendor === 'all' ? undefined : messageVendor(vendor)));
  const psrCount = Number(psrRows[0]?.v ?? 0);

  // scope_type='team' (keyed by users.team_id) never has rows in any real
  // deployment — that column is never populated (no admin UI, no ingest
  // default). 'function' (keyed by admin_users.department) is the group-level
  // scope that's actually written by lib/pulse/aggregator.ts.
  const orsRows = await client
    .select({ v: sql<number | string | null>`AVG(${mt.ors})` })
    .from(mt)
    .where(and(
      mtOnly,
      eq(mt.scope_type, 'function'),
      isNotNull(mt.ors),
      eq(mt.granularity, 'rolling'),
      gte(mt.computed_at, sevenDaysAgo),
    ));
  const orsAvg = orsRows[0]?.v;

  // Tier counts (30 days) bucketed by occurred_at
  const tierRows = await client
    .select({
      t1: sql<number | string>`SUM(CASE WHEN ${schema.pulseClassifications.tier} = 1 THEN 1 ELSE 0 END)`,
      t2: sql<number | string>`SUM(CASE WHEN ${schema.pulseClassifications.tier} = 2 THEN 1 ELSE 0 END)`,
      t3: sql<number | string>`SUM(CASE WHEN ${schema.pulseClassifications.tier} = 3 THEN 1 ELSE 0 END)`,
    })
    .from(schema.pulseClassifications)
    .innerJoin(schema.coworkMessages, eq(schema.coworkMessages.id, schema.pulseClassifications.cowork_message_id))
    .where(and(
      eq(schema.pulseClassifications.classifier_status, 'classified'),
      gte(schema.coworkMessages.occurred_at, thirtyDaysAgo),
      sql.raw(vendorClause(vendor, 'cowork_messages.')),
    ));
  const tierRow = tierRows[0];

  // OTel model mix — top models by request count (30 days)
  const modelMixRaw = await rawAll<{ model: string; cnt: number | string }>(client, sql`
    SELECT model, COUNT(*) AS cnt
    FROM cowork_messages
    WHERE message_type = 'cowork_api_request'
      AND occurred_at >= ${thirtyDaysAgo}
      AND model IS NOT NULL
    GROUP BY model
    ORDER BY cnt DESC
  `);
  const modelMix = modelMixRaw.map(r => ({ model: r.model, cnt: Number(r.cnt) }));

  // OTel permission decisions — accept rate from otel_events tool_decision rows (30 days)
  const decisionExpr = sql`${schema.otelEvents.tool_input} ->> 'decision'`;
  const permRow = await rawGet<{ accepted: number | string; total: number | string }>(client, sql`
    SELECT
      COALESCE(SUM(CASE WHEN ${decisionExpr} = 'accept' THEN 1 ELSE 0 END), 0) AS accepted,
      COUNT(*) AS total
    FROM otel_events
    WHERE event_type = 'tool_decision'
      AND occurred_at >= ${thirtyDaysAgo}
  `);
  const permAccepted = Number(permRow?.accepted ?? 0);
  const permTotal = Number(permRow?.total ?? 0);
  const permissionDecisions = {
    accepted: permAccepted,
    total: permTotal,
    approval_rate: permTotal > 0
      ? Math.round(((permAccepted / permTotal) * 100) * 10) / 10
      : null,
  };

  // Session output rate — additive, own module, 13 completed Monday-UTC weeks.
  // Never throws the whole route: a failure here returns null and the card hides,
  // rather than taking down every other signal on /pulse/cio with it.
  // Every platform, following the switch: Claude Cowork and Office from their
  // telemetry, Claude Chat from what its replies made, ChatGPT from the files
  // OpenAI lists on its replies.
  let sessionOutput = null;
  try {
    sessionOutput = { ...(await buildSessionOutputRate(undefined, vendor)), claudeOnly: false };
  } catch (e) {
    console.error('[org-summary] session output rate failed', e);
  }

  // By product (Claude Chat, Cowork, the Office and Google apps, ChatGPT),
  // following the vendor switch. Additive; only a failure hides the panel.
  // Office and Google rows read 0 until their activity arrives, and Admin →
  // Work Pulse "Show Claude in Office and Google" off leaves them out.
  let byProduct = null;
  try {
    const connected = await getConnectedProducts();
    byProduct = await buildByProduct(now, {
      vendor,
      officeShown: (await getConfigValue('claudeInOfficeShown')) !== 'false',
      chatgpt: connected.openai,
      claude: !isOpenAiOnly(connected),
    });
  } catch (e) {
    console.error('[org-summary] by-product failed', e);
  }

  // Human time vs Claude time — org totals; null when off. Read over the file rate's own
  // window, the 13 completed Monday-UTC weeks (lib/pulse/cowork/session-output-rate.ts), so the
  // overview's "What did the work produce?" card describes one quarter throughout.
  const outputWeeks = weekStarts(now - 7 * 86400, OUTPUT_RATE_WEEKS);
  const humanTime = await readHumanTime('cowork', undefined, vendor, {
    startS: outputWeeks[0], endS: outputWeeks[outputWeeks.length - 1] + 7 * 86400,
  });

  // ── Dashboard figures (additive) ─────────────────────────────────────────
  // The Dashboard's Work Pulse cards, depth panel and skills-and-connectors panel. Weeks are
  // the 8 completed Monday-UTC weeks; a week with no figure is null, never 0.
  // Work Pulse asks for the last quarter (?window=quarter): the 13 completed weeks against the
  // 13 before. The Dashboard keeps the last 30 days against the 30 before, with 8 weeks of trend.
  const quarterly = request.nextUrl.searchParams.get('window') === 'quarter';
  const sixtyDaysAgo = now - 60 * 24 * 3600;
  // The same window the "See who" lists read (lib/pulse/org-window.ts).
  const win = orgSummaryWindow(now, quarterly);
  const weeks = win.weeks;
  const firstWeek = weeks[0];
  const thisWeek = win.thisWeek;
  const bStart = win.start;
  const bEnd = win.end;
  const pStart = quarterly ? firstWeek - 13 * 7 * 86400 : sixtyDaysAgo;
  const weekAvg = async (col: 'oti' | 'ors', scope: 'user' | 'function') => {
    const rows = await client
      .select({ ps: mt.period_start, v: sql<number | string | null>`AVG(${mt[col]})` })
      .from(mt)
      .where(and(mtOnly, eq(mt.scope_type, scope), eq(mt.granularity, 'week'), isNotNull(mt[col]),
        gte(mt.period_start, firstWeek), lt(mt.period_start, thisWeek)))
      .groupBy(mt.period_start);
    const by = new Map(rows.map(r => [Number(r.ps), r.v === null ? null : Math.round(Number(r.v) * 100) / 100]));
    return weeks.map(w => by.get(w) ?? null);
  };
  const tierWeekRows = await rawAll<{ w: number | string; t1: number | string; t2: number | string; t3: number | string }>(client, sql`
    SELECT FLOOR((cm.occurred_at - ${firstWeek}) / ${7 * 86400}) AS w,
           SUM(CASE WHEN pc.tier = 1 THEN 1 ELSE 0 END) AS t1,
           SUM(CASE WHEN pc.tier = 2 THEN 1 ELSE 0 END) AS t2,
           SUM(CASE WHEN pc.tier = 3 THEN 1 ELSE 0 END) AS t3
    FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
    WHERE pc.classifier_status = 'classified' AND cm.occurred_at >= ${firstWeek} AND cm.occurred_at < ${thisWeek}
      AND ${sql.raw(vendorClause(vendor, 'cm.'))}
    GROUP BY 1
  `);
  const tierByWeek = new Map(tierWeekRows.map(r => [Number(r.w), { t1: Number(r.t1), t2: Number(r.t2), t3: Number(r.t3) }]));
  const priorTier = await rawGet<{ t1: number | string | null; t2: number | string | null; t3: number | string | null }>(client, sql`
    SELECT SUM(CASE WHEN pc.tier = 1 THEN 1 ELSE 0 END) AS t1,
           SUM(CASE WHEN pc.tier = 2 THEN 1 ELSE 0 END) AS t2,
           SUM(CASE WHEN pc.tier = 3 THEN 1 ELSE 0 END) AS t3
    FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
    WHERE pc.classifier_status = 'classified' AND cm.occurred_at >= ${pStart} AND cm.occurred_at < ${bStart}
      AND ${sql.raw(vendorClause(vendor, 'cm.'))}
  `);
  const capWeekRows = await rawAll<{ w: number | string; n: number | string }>(client, sql`
    SELECT FLOOR((confirmed_at - ${firstWeek}) / ${7 * 86400}) AS w, COUNT(*) AS n
    FROM pulse_events
    WHERE event_type = 'capability_creation' AND status = 'confirmed'
      AND confirmed_at >= ${firstWeek} AND confirmed_at < ${thisWeek}
    GROUP BY 1
  `);
  const capByWeek = new Map(capWeekRows.map(r => [Number(r.w), Number(r.n)]));
  const capCounts = await rawGet<{ recent: number | string; pending: number | string }>(client, sql`
    SELECT SUM(CASE WHEN status = 'confirmed' AND confirmed_at >= ${bStart} AND confirmed_at < ${bEnd} THEN 1 ELSE 0 END) AS recent,
           SUM(CASE WHEN status = 'candidate' THEN 1 ELSE 0 END) AS pending
    FROM pulse_events pe WHERE event_type = 'capability_creation'
      AND (${sql.raw(vendor === 'all' ? 'TRUE' : 'FALSE')} OR EXISTS (SELECT 1 FROM cowork_messages cm WHERE cm.id = pe.cowork_message_id
        AND ${sql.raw(vendorClause(vendor, 'cm.'))}))
  `);
  // Skills and connectors by the number of people using them: last 30 days against the 30
  // before, and whether each was first seen in the last 30 days.
  const spread = async (table: 'cowork_skill_invocations' | 'cowork_mcp_invocations', col: 'skill_name' | 'mcp_server') => {
    const extra = table === 'cowork_mcp_invocations' ? sql`AND cm.mcp_server NOT IN ('workspace', 'cowork')` : sql``;
    const rows = await rawAll<{ name: string; people: number | string; prior: number | string; first_at: number | string }>(client, sql`
      SELECT cm.${sql.raw(col)} AS name,
             COUNT(DISTINCT CASE WHEN cm.occurred_at >= ${bStart} AND cm.occurred_at < ${bEnd} THEN ${sql.raw(personPerProduct('cm.'))} END) AS people,
             COUNT(DISTINCT CASE WHEN cm.occurred_at >= ${pStart} AND cm.occurred_at < ${bStart} THEN ${sql.raw(personPerProduct('cm.'))} END) AS prior,
             MIN(cm.occurred_at) AS first_at
      FROM ${sql.raw(table)} cm
      WHERE ${vendorSql} ${extra}
      GROUP BY 1
      HAVING COUNT(DISTINCT CASE WHEN cm.occurred_at >= ${bStart} AND cm.occurred_at < ${bEnd} THEN cm.user_id END) > 0
      ORDER BY 2 DESC, 1
    `);
    return {
      total: rows.length,
      rows: rows.slice(0, 5).map(r => ({ name: r.name, people: Number(r.people), priorPeople: Number(r.prior), isNew: Number(r.first_at) >= bStart })),
    };
  };
  // People active on Work Pulse's own platforms (Claude Cowork, Office/Google, Claude Chat, ChatGPT):
  // someone who only uses Claude Code or Codex is Developer Pulse's, not this page's.
  // People figures count a person once for each product they used (personPerProduct), so the
  // All view is Claude's figure plus ChatGPT's, here and in the skill and connector spread.
  const activePeopleRow = await rawGet<{ n: number | string }>(client, sql`
    SELECT COUNT(DISTINCT ${sql.raw(personPerProduct('cm.'))}) AS n FROM cowork_messages cm
    WHERE cm.user_id IS NOT NULL AND cm.occurred_at >= ${bStart} AND cm.occurred_at < ${bEnd}
      AND ${isWorkPulseSurface(sql`cm.surface`, true)} AND ${sql.raw(vendorClause(vendor, 'cm.'))}
  `);
  // People who handed over meaningful or frontier work in the last 30 days, weekly counts of
  // the same, and how many people do half of all frontier work (counts only, no names).
  const deepPeopleRow = await rawGet<{ n: number | string }>(client, sql`
    SELECT COUNT(DISTINCT ${sql.raw(personPerProduct('cm.'))}) AS n
    FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
    WHERE pc.classifier_status = 'classified' AND pc.tier >= 2 AND cm.occurred_at >= ${bStart} AND cm.occurred_at < ${bEnd}
      AND cm.user_id IS NOT NULL AND ${sql.raw(vendorClause(vendor, 'cm.'))}
  `);
  const deepPeopleWeekRows = await rawAll<{ w: number | string; n: number | string }>(client, sql`
    SELECT FLOOR((cm.occurred_at - ${firstWeek}) / ${7 * 86400}) AS w, COUNT(DISTINCT ${sql.raw(personPerProduct('cm.'))}) AS n
    FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
    WHERE pc.classifier_status = 'classified' AND pc.tier >= 2 AND cm.occurred_at >= ${firstWeek} AND cm.occurred_at < ${thisWeek}
      AND cm.user_id IS NOT NULL AND ${sql.raw(vendorClause(vendor, 'cm.'))}
    GROUP BY 1
  `);
  const deepPeopleByWeek = new Map(deepPeopleWeekRows.map(r => [Number(r.w), Number(r.n)]));
  const frontierRows = (await rawAll<{ n: number | string; v: string }>(client, sql`
    SELECT COUNT(*) AS n, MIN(${sql.raw(vendorExpr('cm.'))}) AS v
    FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
    WHERE pc.classifier_status = 'classified' AND pc.tier = 3 AND cm.occurred_at >= ${bStart} AND cm.occurred_at < ${bEnd}
      AND cm.user_id IS NOT NULL AND ${sql.raw(vendorClause(vendor, 'cm.'))}
    GROUP BY ${sql.raw(personPerProduct('cm.'))} ORDER BY 1 DESC
  `)).map(r => ({ n: Number(r.n), v: r.v === 'openai' ? 'openai' as const : 'claude' as const }));
  const frontierByPerson = frontierRows.map(r => r.n);
  const frontierTotal = frontierByPerson.reduce((a, b) => a + b, 0);
  /** The fewest people (each counted once per product) who together do half of the work in `ns`, largest first. */
  const halfOf = (ns: number[]): number => {
    const total = ns.reduce((a, b) => a + b, 0);
    let k = 0;
    for (let acc = 0; k < ns.length && acc < total / 2; k++) acc += ns[k];
    return k;
  };
  // On All, each product's own half added together, so the figure is Claude's plus ChatGPT's like
  // every other All-view figure; the split says which is which.
  const frontierHalfSplit = vendor === 'all'
    && frontierRows.some(r => r.v === 'claude') && frontierRows.some(r => r.v === 'openai')
    ? {
        claude: halfOf(frontierRows.filter(r => r.v === 'claude').map(r => r.n)),
        openai: halfOf(frontierRows.filter(r => r.v === 'openai').map(r => r.n)),
      }
    : null;
  const frontierHalfPeople = frontierHalfSplit ? frontierHalfSplit.claude + frontierHalfSplit.openai : halfOf(frontierByPerson);

  // Tasks by depth over the same window, for the strip's share of real work.
  const windowTier = await rawGet<{ t1: number | string | null; t2: number | string | null; t3: number | string | null }>(client, sql`
    SELECT SUM(CASE WHEN pc.tier = 1 THEN 1 ELSE 0 END) AS t1,
           SUM(CASE WHEN pc.tier = 2 THEN 1 ELSE 0 END) AS t2,
           SUM(CASE WHEN pc.tier = 3 THEN 1 ELSE 0 END) AS t3
    FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
    WHERE pc.classifier_status = 'classified' AND cm.occurred_at >= ${bStart} AND cm.occurred_at < ${bEnd}
      AND ${sql.raw(vendorClause(vendor, 'cm.'))}
  `);

  const dashboard = {
    window: quarterly ? 'quarter' as const : 'month' as const,
    weeks,
    tierCounts: { t1: Number(windowTier?.t1 ?? 0), t2: Number(windowTier?.t2 ?? 0), t3: Number(windowTier?.t3 ?? 0) },
    deepPeople30d: Number(deepPeopleRow?.n ?? 0),
    deepPeopleWeeks: weeks.map((_, i) => deepPeopleByWeek.get(i) ?? 0),
    frontierPeople30d: frontierByPerson.length,
    frontierHalfPeople: frontierTotal > 0 ? frontierHalfPeople : null,
    frontierHalfSplit,
    frontierTopShare: frontierTotal > 0 ? frontierByPerson[0] / frontierTotal : null,
    otiWeeks: await weekAvg('oti', 'user'),
    orsWeeks: await weekAvg('ors', 'function'),
    tierWeeks: weeks.map((_, i) => tierByWeek.get(i) ?? null),
    priorTierCounts: { t1: Number(priorTier?.t1 ?? 0), t2: Number(priorTier?.t2 ?? 0), t3: Number(priorTier?.t3 ?? 0) },
    capabilityWeeks: weeks.map((_, i) => capByWeek.get(i) ?? 0),
    capabilitiesRecent: Number(capCounts?.recent ?? 0),
    capabilitiesPending: Number(capCounts?.pending ?? 0),
    skillSpread: await spread('cowork_skill_invocations', 'skill_name'),
    connectorSpread: await spread('cowork_mcp_invocations', 'mcp_server'),
    activePeople30d: Number(activePeopleRow?.n ?? 0),
  };

  return NextResponse.json({
    tierNames: await getTierNames(),
    dashboard,
    signalCards: {
      oti: otiAvg !== null && otiAvg !== undefined ? Math.round(Number(otiAvg) * 100) / 100 : null,
      dds: ddsAvg !== null && ddsAvg !== undefined ? Math.round(Number(ddsAvg) * 100) / 100 : null,
      psr: psrCount,
      ors: orsAvg !== null && orsAvg !== undefined ? Math.round(Number(orsAvg) * 100) / 100 : null,
    },
    tierCounts: {
      t1: Number(tierRow?.t1 ?? 0),
      t2: Number(tierRow?.t2 ?? 0),
      t3: Number(tierRow?.t3 ?? 0),
    },
    modelMix,
    permissionDecisions,
    sessionOutput,
    byProduct,
    humanTime,
  });
}
