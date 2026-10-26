// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Capability value ledger (metric-refinements §3c). Confirmed capabilities with
// their manager-attributed value. GET returns the rollup + entries for the CIO
// "Value on the table" card; GET ?format=csv is the finance hand-off export.
// admin|manager only — it carries currency figures + attributor names.
// HARD RULE (§3d): this is a STANDALONE ledger, never summed with FinOps spend
// or the Developer Pulse value estimate.
import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { rollupCapabilityValue, type ValuedCapability } from '@/lib/pulse/capability-value';

export const dynamic = 'force-dynamic';

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canAccessPulseAdmin(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const client = await getTypedClient();
  const pe = schema.pulseEvents;

  const rows = await client
    .select({
      title: pe.title, team_id: pe.team_id, tier: pe.tier, confirmed_at: pe.confirmed_at,
      value_type: pe.value_type, value_amount: pe.value_amount, value_period: pe.value_period,
      value_basis: pe.value_basis, attributed_by: pe.attributed_by,
    })
    .from(pe)
    .where(and(eq(pe.event_type, 'capability_creation'), eq(pe.status, 'confirmed')))
    .orderBy(desc(pe.confirmed_at));

  const caps: ValuedCapability[] = rows.map(r => ({
    valueType: (r.value_type as ValuedCapability['valueType']) ?? null,
    valueAmount: r.value_amount === null || r.value_amount === undefined ? null : Number(r.value_amount),
    valuePeriod: (r.value_period as ValuedCapability['valuePeriod']) ?? null,
  }));
  const rollup = rollupCapabilityValue(caps);

  const valued = rows.filter(r => r.value_amount !== null && r.value_amount !== undefined);

  if (request.nextUrl.searchParams.get('format') === 'csv') {
    const header = ['Confirmed', 'Capability', 'Team', 'Tier', 'Value type', 'Amount', 'Period', 'Basis', 'Attributed by'];
    const lines = [header.map(csvCell).join(',')];
    for (const r of valued) {
      const date = r.confirmed_at ? new Date(Number(r.confirmed_at) * 1000).toISOString().slice(0, 10) : '';
      lines.push([date, r.title, r.team_id, r.tier, r.value_type, r.value_amount, r.value_period, r.value_basis, r.attributed_by].map(csvCell).join(','));
    }
    return new NextResponse(lines.join('\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="capability-value-ledger.csv"' },
    });
  }

  return NextResponse.json({
    rollup,
    entries: valued.map(r => ({
      title: r.title,
      team: r.team_id,
      tier: r.tier,
      confirmedAt: r.confirmed_at === null ? null : Number(r.confirmed_at),
      valueType: r.value_type,
      valueAmount: r.value_amount === null || r.value_amount === undefined ? null : Number(r.value_amount),
      valuePeriod: r.value_period,
      valueBasis: r.value_basis,
      attributedBy: r.attributed_by,
    })),
  });
}
