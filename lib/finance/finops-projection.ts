// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * FinOps month-end spend projection — an honest month-to-date run rate.
 *
 * Reuses `projectMonthEndSpend` (Developer Pulse's projection math) but feeds it
 * a real run-rate input instead of double-passing month-to-date spend as
 * both the MTD figure AND the trailing-7-day figure (that bug made the
 * client-side projection materially wrong, especially early in the month).
 *
 * Here we don't have a true trailing-7-day spend figure either, so we
 * derive an honest 7-day-equivalent from the MTD average-per-day
 * (`mtd / daysElapsed * 7`). Fed back into `projectMonthEndSpend`, this
 * collapses to the correct run-rate: `projected = mtd / daysElapsed * daysInMonth`.
 */
import { projectMonthEndSpend, type SpendProjection } from '@/lib/pulse/code/projection';

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
  const daysElapsed = new Date(nowEpochS * 1000).getUTCDate(); // 1-indexed, always >= 1
  const last7dEquivalent = daysElapsed > 0 ? (mtdSpend / daysElapsed) * 7 : 0;
  return projectMonthEndSpend(mtdSpend, last7dEquivalent, nowEpochS);
}
