// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table> for
// plain selects/joins/aggregates via the query builder (Number()-safe since
// Drizzle's own column codecs decode bigint({mode:'number'}) correctly).
import { NextRequest, NextResponse } from 'next/server';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { getAdminSession } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue } from '@/lib/config';
import { getCollectorConnection } from '@/lib/setup/collector';
import { logAccess } from '@/lib/audit/log';
import { OPENAI_SOURCES, OPENAI_USER_SOURCE } from '@/lib/openai/sources';
import { productExpr } from '@/lib/dashboard/product-sql';
import { FIRST_SEEN_USER_SOURCES, firstSeenLabel } from '@/lib/sources/first-seen';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const client = await getTypedClient();
  const cm = schema.coworkMessages;
  const u = schema.users;

  const lastEventRows = await client
    .select({ last_at: sql<number | string | null>`MAX(${cm.occurred_at})` })
    .from(cm)
    .where(eq(cm.source, 'otel'));
  const lastAtRaw = lastEventRows[0]?.last_at;
  const lastOtelEventAt = lastAtRaw !== null && lastAtRaw !== undefined ? Number(lastAtRaw) : null;

  const otelUserCountRows = await client
    .select({ c: sql<number | string>`COUNT(*)` })
    .from(u)
    .where(eq(u.source, 'otel'));
  const otelUserCount = Number(otelUserCountRows[0]?.c ?? 0);

  const today = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
  const newUsersTodayRows = await client
    .select({ c: sql<number | string>`COUNT(*)` })
    .from(u)
    .where(and(eq(u.source, 'otel'), gte(u.first_seen_at, today)));
  const newUsersToday = Number(newUsersTodayRows[0]?.c ?? 0);

  // People first seen through any capture path: Claude's telemetry, Anthropic's
  // Compliance API or OpenAI's. Each is labelled with the product of their
  // earliest surviving prompt, or their arrival route when none survives.
  const recentRows = (await client.execute(sql`
    SELECT u.id, u.display_name, u.email, u.department, u.last_seen_at, u.source,
           fp.product AS first_product, fp.app AS first_app
      FROM users u
      LEFT JOIN LATERAL (
        SELECT ${sql.raw(productExpr('cm.'))} AS product, cm.product AS app
          FROM cowork_messages cm
         WHERE cm.user_id = u.id AND cm.message_type IN ('cowork_user_message', 'code_user_message')
         ORDER BY cm.occurred_at, cm.id
         LIMIT 1
      ) fp ON TRUE
     WHERE u.source IN (${sql.join(FIRST_SEEN_USER_SOURCES.map(v => sql`${v}`), sql`, `)})
     ORDER BY u.last_seen_at DESC
     LIMIT 10`) as unknown as { rows: Array<Record<string, unknown>> }).rows;
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const recentOtelUsers = recentRows.map(r => ({
    id: String(r.id),
    display_name: str(r.display_name),
    email: str(r.email),
    department: str(r.department),
    last_seen_at: r.last_seen_at === null || r.last_seen_at === undefined ? null : Number(r.last_seen_at),
    source: str(r.source),
    first_seen_in: firstSeenLabel(str(r.first_product), str(r.first_app), str(r.source)),
  }));

  // OpenAI's Compliance API (ChatGPT and Codex): the key and workspace live on
  // Admin → Security; this is how the sync is doing.
  const openaiKeySet = !!(await getConfigValue('openaiAdminApiKey')) && !!(await getConfigValue('openaiWorkspaceId')).trim();
  const openaiLastSyncRaw = parseInt(await getConfigValue('openaiLastSyncAt') || '', 10);
  let openaiLastSync: { prompts: number; excluded: number; errors: number } | null = null;
  try {
    const s = JSON.parse((await getConfigValue('openaiLastSyncStats')) || 'null');
    if (s && typeof s === 'object') {
      const prompts = s.prompts && typeof s.prompts === 'object'
        ? Object.values(s.prompts as Record<string, unknown>).reduce<number>((n, v) => n + (Number(v) || 0), 0) : 0;
      openaiLastSync = { prompts, excluded: Number(s.excluded) || 0, errors: Array.isArray(s.errors) ? s.errors.length : 0 };
    }
  } catch { /* malformed stats read as none */ }
  const openaiRecordRows = await client
    .select({
      last_at: sql<number | string | null>`MAX(${cm.occurred_at})`,
      people: sql<number | string>`COUNT(DISTINCT ${cm.user_id})`,
    })
    .from(cm)
    .where(inArray(cm.source, [...OPENAI_SOURCES]));
  const openaiLastAt = openaiRecordRows[0]?.last_at;
  const openaiNewTodayRows = await client
    .select({ c: sql<number | string>`COUNT(*)` })
    .from(u)
    .where(and(eq(u.source, OPENAI_USER_SOURCE), gte(u.first_seen_at, today)));
  const openaiInterval = parseInt(await getConfigValue('openaiSyncIntervalMinutes') || '', 10);

  // Admin only (checked above): the collector address and bearer token for
  // connecting Claude. The token is null when the install does not give it to
  // the Hub. A read of the token is recorded in the access audit log.
  const collector = getCollectorConnection(process.env, await getConfigValue('otelCollectorAddress'));
  if (collector.token) {
    await logAccess({ actorId: session.userId ?? '', actorEmail: session.email ?? '', actorIp: request.headers.get('x-forwarded-for') || undefined, resource: 'collector-token', action: 'READ', outcome: 'success', detail: 'admin/ingestion' });
  }

  return NextResponse.json({
    collectorTokenSet: !!process.env.CCC_COLLECTOR_TOKEN,
    collector,
    lastOtelEventAt,
    otelUserCount,
    newUsersToday,
    recentOtelUsers,
    openai: {
      keySet: openaiKeySet,
      lastSyncAt: Number.isFinite(openaiLastSyncRaw) && openaiLastSyncRaw > 0 ? openaiLastSyncRaw : null,
      lastSync: openaiLastSync,
      lastRecordAt: openaiLastAt !== null && openaiLastAt !== undefined ? Number(openaiLastAt) : null,
      people: Number(openaiRecordRows[0]?.people ?? 0),
      newToday: Number(openaiNewTodayRows[0]?.c ?? 0),
      intervalMinutes: Number.isFinite(openaiInterval) && openaiInterval > 0 ? openaiInterval : 5,
      // The OpenAI panel's switches (Access & Keys): sync paused, and shown on the analytics screens.
      paused: (await getConfigValue('openaiSyncPaused')) === 'true',
      shown: (await getConfigValue('openaiShown')) !== 'false',
    },
  });
}
