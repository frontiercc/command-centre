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
import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { getAdminSession, canAccessOrgOverview } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { buildSessionOutputRate } from '@/lib/pulse/cowork/session-output-rate';
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
async function rawGet<T>(client: unknown, query: unknown): Promise<T | undefined> {
  const rows = await rawAll<T>(client, query);
  return rows[0];
}

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated || !canAccessOrgOverview(session.role)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const client = await getTypedClient();
  const now = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = now - 7 * 24 * 3600;
  const thirtyDaysAgo = now - 30 * 24 * 3600;

  // Org-level signal averages from latest pulse_metrics snapshots
  const ddsRows = await client
    .select({ v: sql<number | string | null>`AVG(${schema.pulseMetrics.dds})` })
    .from(schema.pulseMetrics)
    .where(and(
      eq(schema.pulseMetrics.scope_type, 'user'),
      isNotNull(schema.pulseMetrics.dds),
      eq(schema.pulseMetrics.granularity, 'rolling'),
      gte(schema.pulseMetrics.computed_at, sevenDaysAgo),
    ));
  const ddsAvg = ddsRows[0]?.v;

  const otiRows = await client
    .select({ v: sql<number | string | null>`AVG(${schema.pulseMetrics.oti})` })
    .from(schema.pulseMetrics)
    .where(and(
      eq(schema.pulseMetrics.scope_type, 'user'),
      isNotNull(schema.pulseMetrics.oti),
      eq(schema.pulseMetrics.granularity, 'rolling'),
      gte(schema.pulseMetrics.computed_at, sevenDaysAgo),
    ));
  const otiAvg = otiRows[0]?.v;

  const psrRows = await client
    .select({ v: sql<number | string>`COUNT(*)` })
    .from(schema.pulseEvents)
    .where(and(eq(schema.pulseEvents.event_type, 'capability_creation'), eq(schema.pulseEvents.status, 'confirmed')));
  const psrCount = Number(psrRows[0]?.v ?? 0);

  // scope_type='team' (keyed by users.team_id) never has rows in any real
  // deployment — that column is never populated (no admin UI, no ingest
  // default). 'function' (keyed by admin_users.department) is the group-level
  // scope that's actually written by lib/pulse/aggregator.ts.
  const orsRows = await client
    .select({ v: sql<number | string | null>`AVG(${schema.pulseMetrics.ors})` })
    .from(schema.pulseMetrics)
    .where(and(
      eq(schema.pulseMetrics.scope_type, 'function'),
      isNotNull(schema.pulseMetrics.ors),
      eq(schema.pulseMetrics.granularity, 'rolling'),
      gte(schema.pulseMetrics.computed_at, sevenDaysAgo),
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
    })
    .from(schema.pulseClassifications)
    .innerJoin(schema.coworkMessages, eq(schema.coworkMessages.id, schema.pulseClassifications.cowork_message_id))
    .where(and(
      eq(schema.pulseClassifications.classifier_status, 'classified'),
      gte(schema.coworkMessages.occurred_at, thirtyDaysAgo),
    ))
    .groupBy(schema.pulseClassifications.task_type)
    .orderBy(desc(sql`COUNT(*)`));
  const workMix = workMixRaw.map(r => ({
    task_type: r.task_type,
    messages: Number(r.messages),
    tier3: Number(r.tier3), tier2: Number(r.tier2), tier1: Number(r.tier1),
  }));

  // Top 5 skills org-wide (30 days)
  const topSkills = await rawAll<{ skill_name: string; usage_count: number | string; user_count: number | string }>(client, sql`
    SELECT skill_name,
           COUNT(*) AS usage_count,
           COUNT(DISTINCT user_id) AS user_count
    FROM cowork_skill_invocations
    WHERE occurred_at >= ${thirtyDaysAgo}
    GROUP BY skill_name
    ORDER BY usage_count DESC
    LIMIT 5
  `).then(rows => rows.map(r => ({
    skill_name: r.skill_name,
    usage_count: Number(r.usage_count),
    user_count: Number(r.user_count),
  })));

  // Top 5 connectors org-wide (30 days)
  const topConnectors = await rawAll<{ mcp_server: string; usage_count: number | string; user_count: number | string }>(client, sql`
    SELECT mcp_server,
           COUNT(*) AS usage_count,
           COUNT(DISTINCT user_id) AS user_count
    FROM cowork_mcp_invocations
    WHERE occurred_at >= ${thirtyDaysAgo}
      AND mcp_server NOT IN ('workspace', 'cowork')
    GROUP BY mcp_server
    ORDER BY usage_count DESC
    LIMIT 5
  `).then(rows => rows.map(r => ({
    mcp_server: r.mcp_server,
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

  // Document-upload sessions org-wide (30 days)
  const docSessionRow = await rawGet<{ sessions_with_uploads: number | string; total_uploads: number | string }>(client, sql`
    SELECT COUNT(*) AS sessions_with_uploads,
           COALESCE(SUM(css.upload_count), 0) AS total_uploads
    FROM cowork_session_stats css
    JOIN cowork_sessions cs ON cs.id = css.session_id
    WHERE css.upload_count > 0
      AND cs.started_at >= ${thirtyDaysAgo}
  `);
  const docSessions = {
    sessions_with_uploads: Number(docSessionRow?.sessions_with_uploads ?? 0),
    total_uploads: Number(docSessionRow?.total_uploads ?? 0),
  };

  // Session output rate — additive, own module, 13 completed Monday-UTC weeks.
  // Never throws the whole route: a failure here returns null and the card hides,
  // rather than taking down every other signal on /pulse/cio with it.
  let sessionOutput = null;
  try {
    sessionOutput = await buildSessionOutputRate();
  } catch (e) {
    console.error('[org-summary] session output rate failed', e);
  }

  // Human time vs Claude time — org totals; null when off.
  const humanTime = await readHumanTime('cowork');

  return NextResponse.json({
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
    humanTime,
  });
}
