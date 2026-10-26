// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern (app/api/pulse/cio/route.ts): plain COUNT
// aggregates via the query builder, each Number()-coerced (bigint
// comes back as a STRING on Postgres).
import { NextRequest, NextResponse } from 'next/server';
import { and, eq, gte, ne, sql } from 'drizzle-orm';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated || !canAccessPulseAdmin(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const client = await getTypedClient();
  const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;

  const pc = schema.pulseClassifications;
  const pb = schema.pulseBriefings;
  const pe = schema.pulseEvents;

  const classifiedTotalRows = await client
    .select({ cnt: sql<number | string>`COUNT(*)` })
    .from(pc)
    .where(eq(pc.classifier_status, 'classified'));
  const classifiedTotal = Number(classifiedTotalRows[0]?.cnt ?? 0);

  const classifiedThisWeekRows = await client
    .select({ cnt: sql<number | string>`COUNT(*)` })
    .from(pc)
    .where(and(eq(pc.classifier_status, 'classified'), gte(pc.classified_at, sevenDaysAgo)));
  const classifiedThisWeek = Number(classifiedThisWeekRows[0]?.cnt ?? 0);

  const failedTotalRows = await client
    .select({ cnt: sql<number | string>`COUNT(*)` })
    .from(pc)
    .where(eq(pc.classifier_status, 'failed'));
  const failedTotal = Number(failedTotalRows[0]?.cnt ?? 0);

  // Cowork briefings only — Developer Pulse briefings live under scope_id 'code-org'
  const briefingsTotalRows = await client
    .select({ cnt: sql<number | string>`COUNT(*)` })
    .from(pb)
    .where(ne(pb.scope_id, 'code-org'));
  const briefingsTotal = Number(briefingsTotalRows[0]?.cnt ?? 0);

  const eventsTotalRows = await client
    .select({ cnt: sql<number | string>`COUNT(*)` })
    .from(pe);
  const eventsTotal = Number(eventsTotalRows[0]?.cnt ?? 0);

  return NextResponse.json({
    classifiedTotal,
    classifiedThisWeek,
    failedTotal,
    briefingsTotal,
    eventsTotal,
  });
}
