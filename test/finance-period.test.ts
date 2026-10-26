// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { monthBounds, isCurrentMonth, currentPeriod } from '@/lib/finance/period';
describe('finance/period', () => {
  it('monthBounds gives UTC [start,end) for the month', () => {
    const { start, end } = monthBounds('2026-03');
    expect(new Date(start * 1000).toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(new Date(end * 1000).toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });
  it('currentPeriod + isCurrentMonth', () => {
    const now = Math.floor(Date.UTC(2026, 2, 15) / 1000); // 2026-03-15
    expect(currentPeriod(now)).toBe('2026-03');
    expect(isCurrentMonth('2026-03', now)).toBe(true);
    expect(isCurrentMonth('2026-02', now)).toBe(false);
  });
});
