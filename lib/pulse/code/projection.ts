// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Month-end spend projection: the shared shape, and the UTC day count.
 *
 * Developer Pulse no longer projects with this function. On 2026-11-15 the owner chose to match
 * FinOps, so /api/pulse/code/org-summary calls `buildFinopsProjection`
 * (lib/finance/finops-projection.ts): month-to-date priced spend divided by the exact share of
 * the month gone by. This function stays because `buildFinopsProjection` reads its day count
 * (`daysElapsed`, `daysInMonth`) from here; its own `projected` figure is not shown anywhere.
 */

export interface SpendProjection {
  projected: number;
  daysElapsed: number;
  daysInMonth: number;
}

/**
 * @param mtdSpend Priced spend so far this UTC calendar month.
 * @param last7dSpend Priced spend in the trailing 7 days. Retired as a run rate; FinOps passes 0 and reads only the day count.
 * @param nowEpochS Current time, unix seconds — the "now" the month is measured against.
 */
export function projectMonthEndSpend(
  mtdSpend: number,
  last7dSpend: number,
  nowEpochS: number
): SpendProjection {
  const now = new Date(nowEpochS * 1000);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-indexed
  const daysElapsed = now.getUTCDate(); // 1-indexed day of month = days elapsed so far
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const daysRemaining = daysInMonth - daysElapsed;

  const dailyRunRate = last7dSpend / 7;
  const projected = mtdSpend + dailyRunRate * daysRemaining;

  return { projected, daysElapsed, daysInMonth };
}
