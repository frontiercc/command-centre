// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// My Pulse and Departments' period windows: the week and the month end now; the quarter is the
// 13 completed Monday-UTC weeks, the same weeks as the overview's quarter (app/api/pulse/org-summary).
import { describe, it, expect } from 'vitest';
import { periodWindow } from '@/lib/pulse/my-period';
import { weekStarts } from '@/lib/pulse/period';

const DAY = 86400;
const WEEK = 7 * DAY;

describe('periodWindow', () => {
  // Wednesday 12 November 2025, 15:30 UTC.
  const now = Date.UTC(2025, 10, 12, 15, 30) / 1000;
  const monday = Date.UTC(2025, 10, 10) / 1000;

  it('ends the quarter at the start of the current week, 13 weeks long', () => {
    const w = periodWindow('quarter', now);
    expect(w.end).toBe(monday);
    expect(w.start).toBe(monday - 13 * WEEK);
    expect(new Date(w.start * 1000).getUTCDay()).toBe(1);
  });

  it('matches the overview quarter', () => {
    const weeks = weekStarts(now, 14).slice(0, 13);
    const w = periodWindow('quarter', now);
    expect(w.start).toBe(weeks[0]);
    expect(w.end).toBe(weekStarts(now, 1)[0]);
  });

  it('on a Monday at midnight, the week just begun is not in the quarter', () => {
    const w = periodWindow('quarter', monday);
    expect(w.end).toBe(monday);
    expect(w.start).toBe(monday - 13 * WEEK);
  });

  it('keeps the week and the month ending now', () => {
    expect(periodWindow('week', now)).toEqual({ start: now - 7 * DAY, end: now });
    expect(periodWindow('month', now)).toEqual({ start: now - 30 * DAY, end: now });
  });
});
