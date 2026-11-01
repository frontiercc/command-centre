// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table> for
// plain selects/joins/aggregates via the query builder (Number()-safe since
// Drizzle's own column codecs decode bigint({mode:'number'}) correctly).
import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { getAdminSession } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue } from '@/lib/config';
import { getCollectorConnection } from '@/lib/setup/collector';
import { logAccess } from '@/lib/audit/log';
import { OPENAI_SOURCES, OPENAI_USER_SOURCE } from '@/lib/openai/sources';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated || session.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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

  // People first seen through either capture path: Claude's telemetry or OpenAI's export.
  const recentOtelUsers = await client
    .select({
      id: u.id,
      display_name: u.display_name,
      email: u.email,
      department: u.department,
      last_seen_at: u.last_seen_at,
      source: u.source,
    })
    .from(u)
    .where(inArray(u.source, ['otel', OPENAI_USER_SOURCE]))
    .orderBy(desc(u.last_seen_at))
    .limit(10);

  // OpenAI's export (ChatGPT and Codex): the key and workspace live on
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
    },
  });
}
