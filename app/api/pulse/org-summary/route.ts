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
import { visibleVendor } from '@/lib/sources/openai-visibility';
import { and, desc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { weekStarts } from '@/lib/pulse/period';
import { getAdminSession, canAccessOrgOverview } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { buildSessionOutputRate } from '@/lib/pulse/cowork/session-output-rate';
import { buildByProduct } from '@/lib/pulse/cowork/by-product';
import { getConnectedProducts, isOpenAiOnly } from '@/lib/sources/connected';
import { getConfigValue } from '@/lib/config';
import { readHumanTime } from '@/lib/pulse/human-time-summary';
import { vendorClause, vendorExpr, toolTagExpr, workPulseToolClause } from '@/lib/dashboard/product-sql';
import { messageVendor } from '@/lib/pulse/vendor-filter';
import { getDocSessions } from '@/lib/pulse/cowork/doc-sessions';

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

  // Work Mix (30 days) — breakdown of classified work by task_type, with a
  // tier split per type. Judged layer (same classifier that drives DDS/OTI/
  // ORS above) — always on for Cowork, no separate opt-in flag.
  const workMixRaw = await client
    .select({
      task_type: schema.pulseClassifications.task_type,
      messages: sql<number | string>`COUNT(*)`,
      tier3: sql<number | string>`SUM(CASE WHEN ${schema.pulseClassifications.tier} = 3 THEN 1 ELSE 0 END)`,
      tier2: sql<number | string>`SUM(CASE WHEN ${schema.pulseClassifications.tier} = 2 THEN 1 ELSE 0 END)`,
      tier1: sql<number | string>`SUM(CASE WHEN ${schema.pulseClassifications.tier} = 1 THEN 1 ELSE 0 END)`,
      openai: sql<number | string>`SUM(CASE WHEN ${messageVendor('openai')} THEN 1 ELSE 0 END)`,
    })
    .from(schema.pulseClassifications)
    .innerJoin(schema.coworkMessages, eq(schema.coworkMessages.id, schema.pulseClassifications.cowork_message_id))
    .where(and(
      eq(schema.pulseClassifications.classifier_status, 'classified'),
      gte(schema.coworkMessages.occurred_at, thirtyDaysAgo),
      messageVendor(vendor),
    ))
    .groupBy(schema.pulseClassifications.task_type)
    .orderBy(desc(sql`COUNT(*)`));
  const workMix = workMixRaw.map(r => ({
    task_type: r.task_type,
    messages: Number(r.messages),
    tier3: Number(r.tier3), tier2: Number(r.tier2), tier1: Number(r.tier1),
    claude: Number(r.messages) - Number(r.openai),
    openai: Number(r.openai),
  }));

  // Top 5 skills org-wide (30 days). A skill of the same name from Claude and
  // from OpenAI is two different skills, so each row carries its vendor.
  const topSkills = await rawAll<{ skill_name: string; vendor: string; tag: string; usage_count: number | string; user_count: number | string }>(client, sql`
    SELECT cm.skill_name, ${sql.raw(vendorExpr('cm.'))} AS vendor, ${sql.raw(toolTagExpr('cm.'))} AS tag,
           COUNT(*) AS usage_count,
           COUNT(DISTINCT cm.user_id) AS user_count
    FROM cowork_skill_invocations cm
    WHERE cm.occurred_at >= ${thirtyDaysAgo} AND ${vendorSql}
    GROUP BY 1, 2, 3
    ORDER BY usage_count DESC
    LIMIT 5
  `).then(rows => rows.map(r => ({
    skill_name: r.skill_name,
    vendor: r.vendor as 'claude' | 'openai',
    tag: r.tag,
    usage_count: Number(r.usage_count),
    user_count: Number(r.user_count),
  })));

  // Top 5 connectors org-wide (30 days), each with its vendor.
  const topConnectors = await rawAll<{ mcp_server: string; vendor: string; tag: string; usage_count: number | string; user_count: number | string }>(client, sql`
    SELECT cm.mcp_server, ${sql.raw(vendorExpr('cm.'))} AS vendor, ${sql.raw(toolTagExpr('cm.'))} AS tag,
           COUNT(*) AS usage_count,
           COUNT(DISTINCT cm.user_id) AS user_count
    FROM cowork_mcp_invocations cm
    WHERE cm.occurred_at >= ${thirtyDaysAgo}
      AND cm.mcp_server NOT IN ('workspace', 'cowork')
      AND ${vendorSql}
    GROUP BY 1, 2, 3
    ORDER BY usage_count DESC
    LIMIT 5
  `).then(rows => rows.map(r => ({
    mcp_server: r.mcp_server,
    vendor: r.vendor as 'claude' | 'openai',
    tag: r.tag,
    usage_count: Number(r.usage_count),
    user_count: Number(r.user_count),
  })));

  // Top native tools from OTel session stats (30 days) — aggregate JSON arrays in JS
  const nativeToolRows = await client
    .select({ unique_tools: schema.coworkSessionStats.unique_tools, user_id: schema.coworkSessions.user_id })
    .from(schema.coworkSessionStats)
    .innerJoin(schema.coworkSessions, eq(schema.coworkSessions.id, schema.coworkSessionStats.session_id))
    .where(and(
      isNotNull(schema.coworkSessionStats.unique_tools),
      sql`${schema.coworkSessionStats.unique_tools} != '[]'`,
      gte(schema.coworkSessions.started_at, thirtyDaysAgo),
    ));

  const toolCounts = new Map<string, { usage: number; users: Set<string> }>();
  for (const row of nativeToolRows) {
    let tools: string[] = [];
    try { tools = JSON.parse(row.unique_tools ?? '[]') as string[]; } catch { continue; }
    for (const t of tools) {
      const entry = toolCounts.get(t) ?? { usage: 0, users: new Set() };
      entry.usage++;
      if (row.user_id) entry.users.add(row.user_id);
      toolCounts.set(t, entry);
    }
  }
  const topNativeTools = Array.from(toolCounts.entries())
    .map(([tool_name, e]) => ({ tool_name, usage_count: e.usage, user_count: e.users.size }))
    .sort((a, b) => b.usage_count - a.usage_count)
    .slice(0, 5);

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

  // Document-upload sessions org-wide (30 days), Claude Cowork and ChatGPT alike.
  const docSessions = await getDocSessions({ since: thirtyDaysAgo, vendor });

  // Session output rate — additive, own module, 13 completed Monday-UTC weeks.
  // Never throws the whole route: a failure here returns null and the card hides,
  // rather than taking down every other signal on /pulse/cio with it.
  // Only Claude's telemetry records files made; OpenAI's Compliance API does
  // not, so the ChatGPT view has no card and the other views say the figure
  // is Claude's once ChatGPT is connected.
  let sessionOutput = null;
  try {
    if (vendor !== 'openai') {
      const report = await buildSessionOutputRate();
      sessionOutput = { ...report, claudeOnly: (await getConnectedProducts()).openai };
    }
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

  // Human time vs Claude time — org totals; null when off.
  const humanTime = await readHumanTime('cowork', undefined, vendor);

  // ── Dashboard figures (additive) ─────────────────────────────────────────
  // The Dashboard's Work Pulse cards, depth panel and skills-and-connectors panel. Weeks are
  // the 8 completed Monday-UTC weeks; a week with no figure is null, never 0.
  // Work Pulse asks for the last quarter (?window=quarter): the 13 completed weeks against the
  // 13 before. The Dashboard keeps the last 30 days against the 30 before, with 8 weeks of trend.
  const quarterly = request.nextUrl.searchParams.get('window') === 'quarter';
  const sixtyDaysAgo = now - 60 * 24 * 3600;
  const shown = quarterly ? 13 : 8;
  const weeks = weekStarts(now, shown + 1).slice(0, shown);
  const firstWeek = weeks[0];
  const thisWeek = weekStarts(now, 1)[0];
  const bStart = quarterly ? firstWeek : thirtyDaysAgo;
  const bEnd = quarterly ? thisWeek : now + 1;
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
    FROM pulse_events WHERE event_type = 'capability_creation'
  `);
  // Skills and connectors by the number of people using them: last 30 days against the 30
  // before, and whether each was first seen in the last 30 days.
  const spread = async (table: 'cowork_skill_invocations' | 'cowork_mcp_invocations', col: 'skill_name' | 'mcp_server') => {
    const extra = table === 'cowork_mcp_invocations' ? sql`AND cm.mcp_server NOT IN ('workspace', 'cowork')` : sql``;
    const rows = await rawAll<{ name: string; people: number | string; prior: number | string; first_at: number | string }>(client, sql`
      SELECT cm.${sql.raw(col)} AS name,
             COUNT(DISTINCT CASE WHEN cm.occurred_at >= ${bStart} AND cm.occurred_at < ${bEnd} THEN cm.user_id END) AS people,
             COUNT(DISTINCT CASE WHEN cm.occurred_at >= ${pStart} AND cm.occurred_at < ${bStart} THEN cm.user_id END) AS prior,
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
  const activePeopleRow = await rawGet<{ n: number | string }>(client, sql`
    SELECT COUNT(DISTINCT user_id) AS n FROM cowork_messages cm
    WHERE cm.user_id IS NOT NULL AND cm.occurred_at >= ${bStart} AND cm.occurred_at < ${bEnd} AND ${sql.raw(vendorClause(vendor, 'cm.'))}
  `);
  // People who handed over meaningful or frontier work in the last 30 days, weekly counts of
  // the same, and how many people do half of all frontier work (counts only, no names).
  const deepPeopleRow = await rawGet<{ n: number | string }>(client, sql`
    SELECT COUNT(DISTINCT cm.user_id) AS n
    FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
    WHERE pc.classifier_status = 'classified' AND pc.tier >= 2 AND cm.occurred_at >= ${bStart} AND cm.occurred_at < ${bEnd}
      AND cm.user_id IS NOT NULL AND ${sql.raw(vendorClause(vendor, 'cm.'))}
  `);
  const deepPeopleWeekRows = await rawAll<{ w: number | string; n: number | string }>(client, sql`
    SELECT FLOOR((cm.occurred_at - ${firstWeek}) / ${7 * 86400}) AS w, COUNT(DISTINCT cm.user_id) AS n
    FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
    WHERE pc.classifier_status = 'classified' AND pc.tier >= 2 AND cm.occurred_at >= ${firstWeek} AND cm.occurred_at < ${thisWeek}
      AND cm.user_id IS NOT NULL AND ${sql.raw(vendorClause(vendor, 'cm.'))}
    GROUP BY 1
  `);
  const deepPeopleByWeek = new Map(deepPeopleWeekRows.map(r => [Number(r.w), Number(r.n)]));
  const frontierByPerson = (await rawAll<{ n: number | string }>(client, sql`
    SELECT COUNT(*) AS n
    FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
    WHERE pc.classifier_status = 'classified' AND pc.tier = 3 AND cm.occurred_at >= ${bStart} AND cm.occurred_at < ${bEnd}
      AND cm.user_id IS NOT NULL AND ${sql.raw(vendorClause(vendor, 'cm.'))}
    GROUP BY cm.user_id ORDER BY 1 DESC
  `)).map(r => Number(r.n));
  const frontierTotal = frontierByPerson.reduce((a, b) => a + b, 0);
  let frontierHalfPeople = 0;
  for (let acc = 0; frontierHalfPeople < frontierByPerson.length && acc < frontierTotal / 2; frontierHalfPeople++) acc += frontierByPerson[frontierHalfPeople];

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
    topSkills,
    topConnectors,
    topNativeTools,
    docSessions,
    modelMix,
    permissionDecisions,
    workMix,
    sessionOutput,
    byProduct,
    humanTime,
  });
}
