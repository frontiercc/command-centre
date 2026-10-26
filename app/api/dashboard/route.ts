// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import {
  getActiveUsersThisWeek,
  getActiveUsersLastWeek,
  getEventsLast24h,
  getOpenAlertCount,
  getOpenAlertsBySeverity,
  getCoworkSessionCountThisWeek,
  getAdoptionTrend,
  getSurfaceBreakdown,
  getDepartmentBreakdown,
  getTopUsers,
  getSecurityMetrics,
  getChatMessageCount,
  getChatFlaggedCount,
  getCodeEventCount,
  getCoworkFlaggedCount,
  getCodeFlaggedCount,
  getAvgSessionsPerWeek,
  getCoworkActiveProjectCount,
  getCoworkProjectStats,
} from '@/lib/db/queries';
import { isOtelConfigured, getDataSourceStatus, getConfigValue } from '@/lib/config';
import { getAdminSession, canAccessCorePlatform } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';

// Disable Next.js route caching — all API routes read live data from the database
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
    const weekAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
    const licensedSeatsRaw = parseInt(await getConfigValue('licensedSeats'), 10);
    const licensedSeats = Number.isFinite(licensedSeatsRaw) && licensedSeatsRaw > 0 ? licensedSeatsRaw : null;
    const [
      coworkActiveCount,
      coworkTopProjects,
      activeUsersThisWeek,
      activeUsersLastWeek,
      openAlertCount,
      alertsBySeverity,
      securityMetrics,
      eventsLast24h,
      coworkSessions,
      adoptionTrend,
      surfaceBreakdown,
      departmentBreakdown,
      topUsers,
      chatPrompts,
      chatFlagged,
      coworkFlagged,
      codeEvents,
      codeFlagged,
      avgSessionsPerWeek,
    ] = await Promise.all([
      getCoworkActiveProjectCount(weekAgo),
      getCoworkProjectStats(weekAgo),
      getActiveUsersThisWeek(),
      getActiveUsersLastWeek(),
      getOpenAlertCount(),
      getOpenAlertsBySeverity(),
      getSecurityMetrics(),
      getEventsLast24h(),
      getCoworkSessionCountThisWeek(),
      getAdoptionTrend(14),
      getSurfaceBreakdown(),
      getDepartmentBreakdown(),
      getTopUsers(5),
      getChatMessageCount(),
      getChatFlaggedCount(),
      getCoworkFlaggedCount(),
      getCodeEventCount(),
      getCodeFlaggedCount(),
      getAvgSessionsPerWeek(),
    ]);
    return NextResponse.json({
      stats: {
        activeUsersThisWeek,
        activeUsersLastWeek,
        eventsLast24h,
        openAlertCount,
        alertsBySeverity,
        coworkSessions,
        chatPrompts,
        chatFlagged,
        coworkFlagged,
        codeEvents,
        codeFlagged,
        avgSessionsPerWeek,
        otelConfigured: await isOtelConfigured(),
      },
      adoptionTrend,
      surfaceBreakdown,
      departmentBreakdown,
      topUsers,
      securityMetrics,
      coworkProjects: {
        activeCount: coworkActiveCount,
        topProjects: coworkTopProjects,
      },
      dataSourceStatus: await getDataSourceStatus(),
      licensedSeats,
    });
  } catch (err) {
    return errorResponse('Dashboard API', err);
  }
}
