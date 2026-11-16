// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * FinOps month-end spend projection — an honest month-to-date run rate:
 * `projected = mtd / (share of the month gone by)`, the share measured to the
 * second (Spend Review's pace), so today is not counted as a full day.
 * Developer Pulse projects the same way, through this function.
 */
import { monthDayCount, type SpendProjection } from '@/lib/pulse/code/projection';

/**
 * Days of the month that must have passed before a projection is shown. Earlier, a run rate
 * from one to six days is mostly noise: on 3 October one busy day projected +457% on September.
 * Client-safe constant, read by the insight facts and the projection card.
 */
export const MIN_PROJECTION_DAYS = 7;

/**
 * @param mtdSpend Priced spend so far this UTC calendar month.
 * @param monthToDate Whether the report period is the current, in-progress month.
 * @param nowEpochS Current time, unix seconds.
 * @returns The projection, or `null` for a historical (already-complete) period.
 */
export function buildFinopsProjection(
  mtdSpend: number,
  monthToDate: boolean,
  nowEpochS: number
): SpendProjection | null {
  if (!monthToDate) return null;
  // The day count ("Day N of M", and the seven-day floor) is the calendar day.
  const { daysElapsed, daysInMonth } = monthDayCount(nowEpochS);
  // The run rate uses the exact share of the month gone by, as Spend Review
  // does, so today counts as the part of a day that has passed, not a full day.
  const now = new Date(nowEpochS * 1000);
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const elapsed = Math.min(1, Math.max(0.01, (nowEpochS * 1000 - start) / (end - start)));
  return { projected: mtdSpend / elapsed, daysElapsed, daysInMonth };
}
