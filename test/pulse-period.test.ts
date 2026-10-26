// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { weekStart, priorWeekStart, weekStarts } from '@/lib/pulse/period';

// 2026-07-02 is a Thursday. Monday of that week is 2026-06-29 00:00 UTC.
const THU = Math.floor(Date.UTC(2026, 6, 2, 15, 30) / 1000);
const MON = Math.floor(Date.UTC(2026, 5, 29) / 1000);

describe('weekStart', () => {
  it('returns Monday 00:00 UTC for a mid-week timestamp', () => {
    expect(weekStart(THU)).toBe(MON);
  });
  it('is idempotent on a Monday midnight', () => {
    expect(weekStart(MON)).toBe(MON);
  });
  it('Sunday belongs to the preceding Monday week', () => {
    const SUN = Math.floor(Date.UTC(2026, 6, 5, 23, 59) / 1000);
    expect(weekStart(SUN)).toBe(MON);
  });
});

describe('priorWeekStart', () => {
  it('returns the Monday before', () => {
    expect(priorWeekStart(THU)).toBe(MON - 7 * 86400);
  });
});

describe('weekStarts', () => {
  it('returns n ascending Mondays ending with the current week', () => {
    const starts = weekStarts(THU, 3);
    expect(starts).toEqual([MON - 14 * 86400, MON - 7 * 86400, MON]);
  });
});
