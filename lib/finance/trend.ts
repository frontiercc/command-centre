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
import { buildChargeback, type ChargebackReport } from '@/lib/finance/chargeback';
import { partsOfRows, type ProductParts } from '@/lib/finance/product-split';

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

export async function buildSpendTrend(nowS: number, months = 12): Promise<SpendTrend> {
  const now = new Date(nowS * 1000);
  const series: SpendTrendPoint[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const period = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const report = await buildChargeback(period, nowS);
    series.push({ period, usd: report.grandTotalUsd, parts: reportProductParts(report) });
  }
  const monthsWithSpend = series.filter(p => (p.usd ?? 0) > 0).length;
  return { series, render: monthsWithSpend >= 3 };
}
