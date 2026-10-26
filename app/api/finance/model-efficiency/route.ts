// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { getAllConfig } from '@/lib/config';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';
import { buildModelEfficiency } from '@/lib/finance/model-efficiency';
import { currentPeriod } from '@/lib/finance/period';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const cfg = await getAllConfig();
  if (!(cfg.financeModelEfficiencyEnabled && cfg.chargebackEnabled)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessPulseAdmin(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const surface = request.nextUrl.searchParams.get('surface');
  if (surface !== 'code' && surface !== 'cowork') {
    return NextResponse.json({ error: 'Invalid surface (code|cowork)' }, { status: 400 });
  }
  const period = request.nextUrl.searchParams.get('period') || currentPeriod(Math.floor(Date.now() / 1000));
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return NextResponse.json({ error: 'Invalid period (expected YYYY-MM)' }, { status: 400 });
  }
  await logAccess({
    actorId: session.userId!,
    actorEmail: session.email!,
    actorIp: request.headers.get('x-forwarded-for') || undefined,
    resource: 'finance/model-efficiency',
    action: 'READ',
    outcome: 'success',
  });
  return NextResponse.json(await buildModelEfficiency(surface, period, Math.floor(Date.now() / 1000)));
}
