// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table> for
// plain selects/joins/aggregates via the query builder (Number()-safe since
// Drizzle's own column codecs decode bigint({mode:'number'}) correctly).
import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { getAdminSession } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue } from '@/lib/config';
import { getCollectorConnection } from '@/lib/setup/collector';
import { logAccess } from '@/lib/audit/log';

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

  const recentOtelUsers = await client
    .select({
      id: u.id,
      display_name: u.display_name,
      email: u.email,
      department: u.department,
      last_seen_at: u.last_seen_at,
    })
    .from(u)
    .where(eq(u.source, 'otel'))
    .orderBy(desc(u.last_seen_at))
    .limit(10);

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
  });
}
