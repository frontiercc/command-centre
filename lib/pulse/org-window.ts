// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { weekStarts } from '@/lib/pulse/period';

/**
 * The window behind Work Pulse's headline figures, in one place so a card and the list behind it
 * always read the same days. Work Pulse asks for the last quarter (`quarterly`): the last 13 weeks
 * to now, so a quarter never shows less than the last 30 days. The Dashboard reads the last 30
 * days to now. `weeks` are the completed Monday-UTC weeks the weekly charts draw. Seconds; `end`
 * is exclusive.
 */
export function orgSummaryWindow(now: number, quarterly: boolean): { start: number; end: number; weeks: number[]; thisWeek: number } {
  const shown = quarterly ? 13 : 8;
  const weeks = weekStarts(now, shown + 1).slice(0, shown);
  const thisWeek = weekStarts(now, 1)[0];
  return quarterly
    ? { start: now - 13 * 7 * 24 * 3600, end: now + 1, weeks, thisWeek }
    : { start: now - 30 * 24 * 3600, end: now + 1, weeks, thisWeek };
}
