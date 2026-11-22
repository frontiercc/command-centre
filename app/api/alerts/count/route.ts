// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { getAdminSession, canAccessCorePlatform, isDeptScoped } from '@/lib/auth/admin-auth';
import { getOpenAlertCount } from '@/lib/db/queries';
import { countAlertsByStatusAndType } from '../alert-counts';

export const dynamic = 'force-dynamic';

/**
 * `count` is the number of open alerts (status 'open'), the one figure the
 * dashboard, the admin overview and the sidebar badge all show.
 * `?detail=1` adds the counts by status and type the Alerts page needs, read
 * with SQL so they are never cut short by the list's 500-row cap.
 */
export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessCorePlatform(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (request.nextUrl.searchParams.get('detail') !== '1') {
    return NextResponse.json({ count: await getOpenAlertCount() });
  }

  // Same department rule as the list in /api/alerts.
  const department = isDeptScoped(session.role)
    ? (session.department || undefined)
    : (request.nextUrl.searchParams.get('department') || undefined);
  const rows = await countAlertsByStatusAndType(department);
  const count = rows.filter(r => r.status === 'open').reduce((s, r) => s + r.count, 0);
  return NextResponse.json({ count, rows });
}
