// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { visibleVendor, visibleOpenAi } from '@/lib/sources/openai-visibility';
import {
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
import { productsShown } from '@/lib/dashboard/vendor';
import {
  hasOpenAiData,
  getActiveUsersThisAndLastWeek,
  getSessionsPerWeekByProduct,
  getFlaggedByProduct,
  getDailyPanelsByProduct,
  getDepartmentBreakdownByProduct,
  getTopUsersByProduct,
  DASHBOARD_PANEL_DAYS,
} from '@/lib/dashboard/queries';

/** A percentage target from config: blank means the default, 0 means no target. */
function parseTarget(raw: string, fallback: number): number | null {
  if (raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : null;
}

/** The dashboard's figures for one vendor view, the same for every viewer allowed in. */
export async function buildDashboard(vendorParam: string | null) {
  // Stage 1: the view. The vendor switch: 'all' keeps every reader as it was;
  // 'claude' or 'openai' narrows the people, the three boxes and the charts.
  // Events ingested and open alerts always cover every product.
  const nowS = Math.floor(Date.now() / 1000);
  const weekAgo = nowS - 7 * 24 * 60 * 60;
  const [vendor, openaiPresent] = await Promise.all([
    visibleVendor(vendorParam),
    visibleOpenAi(hasOpenAiData()),
  ]);
  // The products the charts show: the chosen vendor's, or all six in the All view.
  const shown = productsShown(vendor, openaiPresent);

  // Stage 2: every figure and setting, read at the same time. Each is read once:
  // the active-people figures for this week, last week and the vendor split
  // share one query, and the adoption trend and the people-a-day panel another.
  const [
    licensedSeatsSetting,
    coworkActiveCount,
    coworkTopProjects,
    activeByWeek,
    openAlertCount,
    alertsBySeverity,
    securityMetrics,
    eventsLast24h,
    coworkSessions,
    dailyPanels,
    surfaceBreakdown,
    departmentBreakdown,
    topUsers,
    chatPrompts,
    codeEvents,
    sessionsByProduct,
    flaggedByProduct,
    otelConfigured,
    officeShownSetting,
    dataSourceStatus,
    adoptionTargetSetting,
  ] = await Promise.all([
    getConfigValue('licensedSeats'),
    getCoworkActiveProjectCount(weekAgo),
    getCoworkProjectStats(weekAgo),
    getActiveUsersThisAndLastWeek(nowS),
    getOpenAlertCount(),
    getOpenAlertsBySeverity(),
    getSecurityMetrics(),
    getEventsLast24h(),
    getCoworkSessionCountThisWeek(),
    getDailyPanelsByProduct(14, DASHBOARD_PANEL_DAYS, nowS),
    getSurfaceBreakdown(),
    getDepartmentBreakdownByProduct(vendor),
    getTopUsersByProduct(5, shown),
    getChatMessageCount(),
    getCodeEventCount(),
    getSessionsPerWeekByProduct(nowS),
    getFlaggedByProduct(),
    isOtelConfigured(),
    getConfigValue('claudeInOfficeShown'),
    getDataSourceStatus(),
    getConfigValue('targetDeptAdoptionPct'),
  ]);

  // Stage 3: split the shared results for each panel.
  const licensedSeatsRaw = parseInt(licensedSeatsSetting, 10);
  const licensedSeats = Number.isFinite(licensedSeatsRaw) && licensedSeatsRaw > 0 ? licensedSeatsRaw : null;
  // People active in a week for the chosen vendor. All is Claude's people plus
  // OpenAI's, so it adds up to the split shown beside it.
  const peopleFor = (week: { claude: number; openai: number }) => (vendor === 'all' ? week.claude + week.openai : week[vendor]);
  const activeUsersThisWeek = peopleFor(activeByWeek.thisWeek);
  const activeUsersLastWeek = peopleFor(activeByWeek.lastWeek);
  const activeByVendor = activeByWeek.thisWeek;
  const { adoptionTrend, peopleByDay } = dailyPanels;
  // A box's figure for the chosen vendor.
  const pick = (s: { total: number; claude: number; openai: number }) => (vendor === 'all' ? s.total : s[vendor]);
  return ({
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
      otelConfigured,
    },
    vendor,
    openaiPresent,
    // Product ids the charts show, in display order.
    productsShown: shown.map(p => p.id),
    // Claude in Office and Google shown (Admin → Work Pulse): Claude Cowork is then "Claude Cowork and apps".
    officeShown: officeShownSetting !== 'false',
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
    dataSourceStatus,
    licensedSeats,
    // People a day per product, last 14 days, oldest first (additive).
    peopleByDay,
    // Department adoption target (Admin → System), a percentage; null when switched off.
    adoptionTargetPct: parseTarget(adoptionTargetSetting, 50),
  });
}
