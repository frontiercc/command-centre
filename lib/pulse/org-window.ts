// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { weekStarts } from '@/lib/pulse/period';

/**
 * The window behind Work Pulse's headline figures, in one place so a card and the list behind it
 * always read the same weeks. Work Pulse asks for the last quarter (`quarterly`): the 13 completed
 * Monday-UTC weeks. The Dashboard reads the last 30 days to now. Seconds; `end` is exclusive.
 */
export function orgSummaryWindow(now: number, quarterly: boolean): { start: number; end: number; weeks: number[]; thisWeek: number } {
  const shown = quarterly ? 13 : 8;
  const weeks = weekStarts(now, shown + 1).slice(0, shown);
  const thisWeek = weekStarts(now, 1)[0];
  return quarterly
    ? { start: weeks[0], end: thisWeek, weeks, thisWeek }
    : { start: now - 30 * 24 * 3600, end: now + 1, weeks, thisWeek };
}
