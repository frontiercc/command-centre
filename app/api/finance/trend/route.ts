// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { getAllConfig } from '@/lib/config';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';
import { buildSpendTrend } from '@/lib/finance/trend';
import { keptFigures } from '@/lib/kept-figures';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if ((await getAllConfig()).chargebackEnabled !== true) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessPulseAdmin(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const monthsParam = Number(request.nextUrl.searchParams.get('months'));
  const months = Number.isFinite(monthsParam) && monthsParam > 0
    ? Math.min(24, Math.max(1, Math.floor(monthsParam)))
    : 12;
  await logAccess({
    actorId: session.userId!,
    actorEmail: session.email!,
    actorIp: request.headers.get('x-forwarded-for') || undefined,
    resource: 'finance/chargeback',
    action: 'READ',
    outcome: 'success',
  });
  // Kept and refreshed in the background every few minutes (lib/kept-figures.ts).
  return NextResponse.json(await keptFigures(`finance-trend:${months}`,
    () => buildSpendTrend(Math.floor(Date.now() / 1000), months, { keepFinishedMonths: true }),
    { force: request.nextUrl.searchParams.get('fresh') === '1' }));
}
