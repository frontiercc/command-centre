// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Developer Pulse — month-end spend projection.
 *
 * Pure math, no DB: extends the last-7-day priced spend run rate out to the
 * end of the current UTC calendar month, added to month-to-date priced
 * spend already incurred. This is a projection ON TOP OF the existing
 * measured/estimated spend numbers — it inherits their caveats (unpriced
 * models contribute nothing; the `spendIsPartlyEstimated` badge already
 * covers Bedrock/Vertex list-rate estimates) rather than adding new ones.
 */

export interface SpendProjection {
  projected: number;
  daysElapsed: number;
  daysInMonth: number;
}

/**
 * @param mtdSpend Priced spend so far this UTC calendar month.
 * @param last7dSpend Priced spend in the trailing 7 days (used as the run rate).
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
