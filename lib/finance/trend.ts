// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * 12-month spend trend — one point per calendar month up to the current,
 * each priced via `buildChargeback` (Claude Code and Cowork, plus ChatGPT and Codex when connected). The UI
 * hides the chart unless at least 3 months have real (>0) spend, so a brand
 * new deployment with 1 month of data doesn't render a misleading trend.
 *
 * Each month also carries its spend by product (lib/finance/product-split.ts),
 * read from the same report's per-person figures, so the parts add up to the
 * month's FinOps headline (`usd`). A closed month frozen before ChatGPT and
 * Codex existed counts as Claude, split into Code and Cowork when its
 * snapshot has them, otherwise one undivided Claude part.
 */
import { buildChargeback, type ChargebackReport, type ChargebackShared } from '@/lib/finance/chargeback';
import { partsOfRows, type ProductParts } from '@/lib/finance/product-split';
import { cached, PAST_MONTH_FRESH_MS } from '@/lib/finance/spend-review-cache';

/** Months built at once on a first visit: enough to overlap, few enough not to queue the database. */
const MONTHS_AT_ONCE = 3;

export interface SpendTrendPoint {
  period: string;
  usd: number | null;
  /** The month's spend by product; adds up to `usd`. */
  parts: ProductParts;
}

export interface SpendTrend {
  series: SpendTrendPoint[];
  render: boolean;
}

/** A report's spend by product, from its per-person figures (old snapshots included). */
export function reportProductParts(report: Pick<ChargebackReport, 'grandTotalUsd' | 'costCentres' | 'unallocated'>): ProductParts {
  const users = [...(report.costCentres ?? []).flatMap(c => c.users ?? []), ...(report.unallocated?.users ?? [])];
  return partsOfRows(users, report.grandTotalUsd);
}

/**
 * With `keepFinishedMonths`, a finished month's report is kept for an hour (Spend Review's rule for
 * past months, through the same cache), so a visit works out only the current month; a late row for
 * a past month shows within the hour. Without it every month is built fresh.
 */
export async function buildSpendTrend(
  nowS: number,
  months = 12,
  opts: { keepFinishedMonths?: boolean } = {},
): Promise<SpendTrend> {
  const now = new Date(nowS * 1000);
  const periods: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    periods.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  const current = periods[periods.length - 1];
  const shared: ChargebackShared = {};
  let requestDone = false;
  // A kept month rebuilt in the background later reads its own lookups and clock, not this request's.
  const keptBuild = (period: string) => () =>
    requestDone ? buildChargeback(period) : buildChargeback(period, nowS, shared);
  const reportFor = (period: string): Promise<ChargebackReport> =>
    opts.keepFinishedMonths && period !== current
      ? cached(`finance-trend:${period}`, PAST_MONTH_FRESH_MS, keptBuild(period)).then(r => r.value)
      : buildChargeback(period, nowS, shared);

  // A few months at a time, in order, sharing the lookups every month reads.
  const reports: ChargebackReport[] = new Array(periods.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(MONTHS_AT_ONCE, periods.length) }, async () => {
    while (next < periods.length) {
      const i = next++;
      reports[i] = await reportFor(periods[i]);
    }
  }));
  requestDone = true;

  const series: SpendTrendPoint[] = periods.map((period, i) => {
    const report = reports[i];
    // A month with no people and no unallocated spend has no data: null,
    // drawn as "no data", never a $0.00 bar.
    const hasUsers = (report.costCentres ?? []).some(c => (c.users ?? []).length > 0) || (report.unallocated?.users ?? []).length > 0;
    const noData = !hasUsers && (report.unallocated?.totalUsd ?? 0) === 0;
    return { period, usd: noData ? null : report.grandTotalUsd, parts: reportProductParts(report) };
  });
  const monthsWithSpend = series.filter(p => (p.usd ?? 0) > 0).length;
  return { series, render: monthsWithSpend >= 3 };
}
