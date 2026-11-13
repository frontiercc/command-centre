// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * My Pulse's period: its shape and the figures it carries. Client-safe, no imports, so a page
 * can read it without pulling the database client into the browser bundle. The reader itself is
 * lib/pulse/my-period.ts.
 */

const DAY = 86400;
const WEEK = 7 * DAY;

export type PulsePeriod = 'week' | 'month' | 'quarter';

/** Bars in the window, and how long each one is. The window is buckets × bucketSecs, ending now. */
export const PERIOD_SHAPE: Record<PulsePeriod, { buckets: number; bucketSecs: number; label: string; prior: string }> = {
  week: { buckets: 7, bucketSecs: DAY, label: 'This week', prior: 'last week' },
  month: { buckets: 30, bucketSecs: DAY, label: 'This month', prior: 'the month before' },
  quarter: { buckets: 13, bucketSecs: WEEK, label: 'This quarter', prior: 'the quarter before' },
};

export interface PeriodTierWeek { weekStart: number; t1: number; t2: number; t3: number }

export interface MyPeriod {
  period: PulsePeriod;
  start: number;
  end: number;
  /** A year of completed weeks, oldest first, for the depth chart's longer settings. */
  weeks: PeriodTierWeek[];
  /** Six weeks counting back from today, newest week last; the current week is included. */
  grid: PeriodTierWeek[];
  /** A department only: how many of its people did any of this work. */
  people?: { deep: number; active: number } | null;
  realWork: { now: number; all: number; before: number; beforeAll: number; trend: number[]; deptAverage: number | null };
  share: { now: number | null; before: number | null; trend: Array<number | null> };
  capabilities: { confirmed: number; before: number; pending: number; trend: number[] };
  /** Null when switched off, when the viewer may not see it, or with nothing estimated yet. */
  humanTime: { sessions: number; likelyMinutes: number; claudeMinutes: number; trend: number[] } | null;
  produced: { files: number; sessions: number; byKind: Array<{ kind: string; files: number }> };
  colleagueTools: Array<{ type: 'skill' | 'connector'; name: string; people: number; libraryId: number | null }>;
  ownTools: string[];
}
