// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Writes an
// IMMUTABLE snapshot (chargeback_periods.snapshot_json — TEXT, so
// JSON.stringify()'d) and marks the
// period closed; already-closed -> 409. buildChargeback is async and
// awaited. The read-then-write here runs without a transaction.
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getAllConfig } from '@/lib/config';
import { requireAdmin } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { buildChargeback } from '@/lib/finance/chargeback';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if ((await getAllConfig()).chargebackEnabled !== true) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const session = await requireAdmin(request);
  if (!session) return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });

  let body: { period?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }); }
  const period = body.period;
  if (!period || !/^\d{4}-\d{2}$/.test(period)) return NextResponse.json({ error: 'Invalid period (expected YYYY-MM)' }, { status: 400 });

  const client = await getTypedClient();
  const existingRows = await client
    .select({ status: schema.chargebackPeriods.status })
    .from(schema.chargebackPeriods)
    .where(eq(schema.chargebackPeriods.period, period))
    .limit(1);
  if (existingRows[0]?.status === 'closed') return NextResponse.json({ error: 'Period already closed' }, { status: 409 });

  // Compute the report fresh (period is not closed → buildChargeback recomputes), then freeze it.
  const report = await buildChargeback(period);
  const now = Math.floor(Date.now() / 1000);
  const closedReport = { ...report, status: 'closed' as const, closedAt: now };
  const snapshotJson = JSON.stringify(closedReport);
  const estimated = report.estimated ? 1 : 0;
  const closedBy = session.email ?? session.userId ?? 'admin';

  await client
    .insert(schema.chargebackPeriods)
    .values({ period, status: 'closed', closed_at: now, closed_by: closedBy, snapshot_json: snapshotJson, estimated })
    .onConflictDoUpdate({
      target: schema.chargebackPeriods.period,
      set: { status: 'closed', closed_at: now, closed_by: closedBy, snapshot_json: snapshotJson, estimated },
    });

  await logAccess({ actorId: session.userId!, actorEmail: session.email!, actorIp: request.headers.get('x-forwarded-for') || undefined, resource: 'finance/chargeback', action: 'WRITE', outcome: 'success', detail: `close ${period}` });

  return NextResponse.json({ ok: true, period, status: 'closed', closedAt: now, estimated: report.estimated });
}
