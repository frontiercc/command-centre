// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Month-end spend projection: the shared shape and the UTC day count.
 *
 * Developer Pulse and FinOps project the same way (the owner chose this on 2026-11-15):
 * month-to-date priced spend divided by the exact share of the month gone by, in
 * `buildFinopsProjection` (lib/finance/finops-projection.ts). Neither uses a trailing
 * 7-day run rate any more.
 */

export interface SpendProjection {
  projected: number;
  daysElapsed: number;
  daysInMonth: number;
}

/** The UTC calendar day of the month ("Day N of M") at `nowEpochS`, unix seconds. */
export function monthDayCount(nowEpochS: number): { daysElapsed: number; daysInMonth: number } {
  const now = new Date(nowEpochS * 1000);
  const daysElapsed = now.getUTCDate(); // 1-indexed day of month = days elapsed so far
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return { daysElapsed, daysInMonth };
}
