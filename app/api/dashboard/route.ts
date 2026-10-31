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
  getSurfaceBreakdown,
  getSecurityMetrics,
  getChatMessageCount,
  getCodeEventCount,
  getCoworkActiveProjectCount,
  getCoworkProjectStats,
} from '@/lib/db/queries';
import { isOtelConfigured, getDataSourceStatus, getConfigValue } from '@/lib/config';
import { getAdminSession, canAccessCorePlatform } from '@/lib/auth/admin-auth';
import { logAccess } from '@/lib/audit/log';
import { parseVendor } from '@/lib/dashboard/vendor';
import {
  hasOpenAiData,
  getActiveUsersByVendor,
  getActiveUsersForVendor,
  getSessionsPerWeekByProduct,
  getFlaggedByProduct,
  getAdoptionTrendByVendor,
  getDepartmentBreakdownByVendor,
  getTopUsersByVendor,
} from '@/lib/dashboard/queries';

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
    // The vendor switch: 'all' keeps every reader as it was; 'claude' or
    // 'openai' narrows the people, the three boxes and the charts. Events
    // ingested and open alerts always cover every product.
    const vendor = parseVendor(request.nextUrl.searchParams.get('vendor'));
    const nowS = Math.floor(Date.now() / 1000);
    const weekAgo = nowS - 7 * 24 * 60 * 60;
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
      codeEvents,
      openaiPresent,
      activeByVendor,
      sessionsByProduct,
      flaggedByProduct,
    ] = await Promise.all([
      getCoworkActiveProjectCount(weekAgo),
      getCoworkProjectStats(weekAgo),
      vendor === 'all' ? getActiveUsersThisWeek() : getActiveUsersForVendor(vendor, nowS),
      vendor === 'all' ? getActiveUsersLastWeek() : getActiveUsersForVendor(vendor, weekAgo),
      getOpenAlertCount(),
      getOpenAlertsBySeverity(),
      getSecurityMetrics(),
      getEventsLast24h(),
      getCoworkSessionCountThisWeek(),
      getAdoptionTrendByVendor(14, vendor),
      getSurfaceBreakdown(),
      getDepartmentBreakdownByVendor(vendor),
      getTopUsersByVendor(5, vendor),
      getChatMessageCount(),
      getCodeEventCount(),
      hasOpenAiData(),
      getActiveUsersByVendor(nowS),
      getSessionsPerWeekByProduct(nowS),
      getFlaggedByProduct(),
    ]);
    // A box's figure for the chosen vendor.
    const pick = (s: { total: number; claude: number; openai: number }) => (vendor === 'all' ? s.total : s[vendor]);
    return NextResponse.json({
      stats: {
        activeUsersThisWeek,
        activeUsersLastWeek,
        eventsLast24h,
        openAlertCount,
        alertsBySeverity,
        coworkSessions,
        chatPrompts,
        chatFlagged: pick(flaggedByProduct.chat),
        coworkFlagged: pick(flaggedByProduct.work),
        codeEvents,
        codeFlagged: pick(flaggedByProduct.code),
        // cowork is the Work box: Claude Cowork and ChatGPT Work.
        avgSessionsPerWeek: {
          cowork: pick(sessionsByProduct.work),
          code: pick(sessionsByProduct.code),
          chat: pick(sessionsByProduct.chat),
        },
        otelConfigured: await isOtelConfigured(),
      },
      vendor,
      openaiPresent,
      // Each box's Claude and OpenAI figures, for the line under it in the All view.
      products: { sessions: sessionsByProduct, flagged: flaggedByProduct, activeUsers: activeByVendor },
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
