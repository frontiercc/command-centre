// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// My Pulse and Departments' period windows: the week, the month and the quarter all end now, so a
// quarter never shows less than the last 30 days, and the quarter matches the overview's quarter.
import { describe, it, expect } from 'vitest';
import { periodWindow } from '@/lib/pulse/my-period';
import { orgSummaryWindow } from '@/lib/pulse/org-window';

const DAY = 86400;
const WEEK = 7 * DAY;

describe('periodWindow', () => {
  // Wednesday 12 November 2025, 15:30 UTC.
  const now = Date.UTC(2025, 10, 12, 15, 30) / 1000;

  it('ends the quarter now, 13 weeks long', () => {
    expect(periodWindow('quarter', now)).toEqual({ start: now - 13 * WEEK, end: now });
  });

  it('a quarter always covers the last 30 days', () => {
    const q = periodWindow('quarter', now);
    const m = periodWindow('month', now);
    expect(q.start).toBeLessThanOrEqual(m.start);
    expect(q.end).toBe(m.end);
  });

  it('matches the overview quarter', () => {
    const w = periodWindow('quarter', now);
    const o = orgSummaryWindow(now, true);
    expect(o.start).toBe(w.start);
    expect(o.end).toBe(w.end + 1);
  });

  it('keeps the week and the month ending now', () => {
    expect(periodWindow('week', now)).toEqual({ start: now - 7 * DAY, end: now });
    expect(periodWindow('month', now)).toEqual({ start: now - 30 * DAY, end: now });
  });
});
