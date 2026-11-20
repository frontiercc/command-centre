// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The dashboard's figures are the same for every viewer the role check lets in, so they are built
// by lib/dashboard/build.ts, kept, and refreshed in the background every few minutes
// (lib/kept-figures.ts): a visit reads the kept result. The open-alert counts are read fresh on
// every visit, so resolving an alert shows at once.
import { NextRequest, NextResponse } from 'next/server';
import { visibleVendor } from '@/lib/sources/openai-visibility';
import { errorResponse } from '@/lib/api/errors';
import { getOpenAlertCount, getOpenAlertsBySeverity } from '@/lib/db/queries';
import { getAdminSession, canAccessCorePlatform } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';
import { keptFigures } from '@/lib/kept-figures';
import { buildDashboard } from '@/lib/dashboard/build';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessCorePlatform(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  await logAccess({ actorId: session.userId!, actorEmail: session.email!, actorIp: request.headers.get('x-forwarded-for') || undefined, resource: 'dashboard', action: 'READ', outcome: 'success' });
  try {
    const vendor = await visibleVendor(request.nextUrl.searchParams.get('vendor'));
    const [kept, openAlertCount, alertsBySeverity] = await Promise.all([
      keptFigures(`dashboard:${vendor}`, () => buildDashboard(vendor), { force: request.nextUrl.searchParams.get('fresh') === '1' }),
      getOpenAlertCount(),
      getOpenAlertsBySeverity(),
    ]);
    return NextResponse.json({ ...kept, stats: { ...kept.stats, openAlertCount, alertsBySeverity } });
  } catch (err) {
    return errorResponse('Dashboard API', err);
  }
}
