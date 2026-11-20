// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { getAllConfig } from '@/lib/config';
import { getAdminSession, canAccessPulseAdmin } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';
import { currentPeriod } from '@/lib/finance/period';
import { keptFigures } from '@/lib/kept-figures';
import { buildChargebackView } from '@/lib/finance/chargeback-view';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const config = await getAllConfig();
  if (config.chargebackEnabled !== true) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessPulseAdmin(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const period = request.nextUrl.searchParams.get('period') || currentPeriod(Math.floor(Date.now() / 1000));
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return NextResponse.json({ error: 'Invalid period (expected YYYY-MM)' }, { status: 400 });
  }

  await logAccess({
    actorId: session.userId!,
    actorEmail: session.email!,
    actorIp: request.headers.get('x-forwarded-for') || undefined,
    resource: 'finance/chargeback',
    action: 'READ',
    outcome: 'success',
  });
  // The same for every viewer allowed in, so kept and refreshed in the background every few
  // minutes (lib/kept-figures.ts). A report with a side panel that failed is shown, never kept.
  return NextResponse.json(await keptFigures(`chargeback:${period}`, () => buildChargebackView(period), {
    keep: v => v.failed.length === 0,
    force: request.nextUrl.searchParams.get('fresh') === '1',
  }));
}
