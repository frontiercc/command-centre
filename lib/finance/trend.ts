// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * 12-month spend trend — one point per calendar month up to the current,
 * each priced via `buildChargeback` (measured Code + Cowork spend). The UI
 * hides the chart unless at least 3 months have real (>0) spend, so a brand
 * new deployment with 1 month of data doesn't render a misleading trend.
 */
import { buildChargeback } from '@/lib/finance/chargeback';

export interface SpendTrendPoint {
  period: string;
  usd: number | null;
}

export interface SpendTrend {
  series: SpendTrendPoint[];
  render: boolean;
}

export async function buildSpendTrend(nowS: number, months = 12): Promise<SpendTrend> {
  const now = new Date(nowS * 1000);
  const series: SpendTrendPoint[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const period = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const usd = (await buildChargeback(period, nowS)).grandTotalUsd;
    series.push({ period, usd });
  }
  const monthsWithSpend = series.filter(p => (p.usd ?? 0) > 0).length;
  return { series, render: monthsWithSpend >= 3 };
}
