// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The views kept ready from start-up (lib/kept-figures.ts keepWarm): the organisation-wide pages
// every viewer allowed in sees the same way, so the first visit after a restart reads prepared
// figures instead of waiting. Views that differ by viewer (a person's own page, a department) are
// kept from their first visit on.
//
// Each key is worked out exactly as its route works it out (through visibleVendor, currentPeriod),
// so a prepared view is the one the page asks for.
import { keepWarm, type WarmView } from '@/lib/kept-figures';
import { visibleVendor } from '@/lib/sources/openai-visibility';
import { getAllConfig } from '@/lib/config';
import { currentPeriod } from '@/lib/finance/period';
import { buildDashboard } from '@/lib/dashboard/build';
import { buildCodeOrgSummary } from '@/lib/pulse/code/org-summary';
import { buildOrgSummary, keepOrgSummary } from '@/lib/pulse/org-summary';
import { buildStickinessView } from '@/lib/pulse/stickiness';
import { buildUsersList } from '@/lib/pulse/users-list';
import { buildCodeUsersList } from '@/lib/pulse/code/users-list';
import { buildChargebackView } from '@/lib/finance/chargeback-view';
import { buildSpendTrend } from '@/lib/finance/trend';
import { buildModelEfficiency } from '@/lib/finance/model-efficiency';

let registered = false;

/** The start-up views, in the order a first visitor is most likely to open them. */
export async function warmViews(): Promise<WarmView[]> {
  const views: WarmView[] = [];
  // The vendor views the switch can show: just one when ChatGPT and Codex are hidden.
  const vendors = [...new Set(await Promise.all(['all', 'claude', 'openai'].map(v => visibleVendor(v))))];
  for (const vendor of vendors) {
    views.push(
      { key: `dashboard:${vendor}`, build: () => buildDashboard(vendor) },
      { key: `stickiness:${vendor}`, build: () => buildStickinessView(vendor) },
      { key: `org-summary:${vendor}:30d`, build: () => buildOrgSummary(vendor, false), keep: v => keepOrgSummary(v as Awaited<ReturnType<typeof buildOrgSummary>>) },
      { key: `code-org-summary:${vendor}`, build: () => buildCodeOrgSummary(vendor) },
      { key: `pulse-users::${vendor}`, build: () => buildUsersList(undefined, vendor) },
      { key: `code-users::${vendor}`, build: () => buildCodeUsersList(null, vendor) },
    );
  }

  const config = await getAllConfig();
  if (config.chargebackEnabled === true) {
    const period = currentPeriod(Math.floor(Date.now() / 1000));
    views.push(
      { key: `chargeback:${period}`, build: () => buildChargebackView(period), keep: v => (v as { failed: string[] }).failed.length === 0 },
      { key: 'finance-trend:12', build: () => buildSpendTrend(Math.floor(Date.now() / 1000), 12, { keepFinishedMonths: true }) },
    );
    if (config.financeModelEfficiencyEnabled) {
      for (const surface of ['code', 'cowork'] as const) {
        views.push({ key: `model-efficiency:${surface}:${period}`, build: () => buildModelEfficiency(surface, period, Math.floor(Date.now() / 1000)) });
      }
    }
  }
  return views;
}

/** Registers the start-up views once per process. */
export function registerWarmViews(): void {
  if (registered) return;
  registered = true;
  keepWarm(warmViews);
}
