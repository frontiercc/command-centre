// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// A briefing names a whole calendar month by its month, and any other window by its dates.
import { describe, it, expect } from 'vitest';
import { briefingPeriodLabel } from '@/lib/pulse/briefings/described-facts';

const s = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

describe('briefingPeriodLabel', () => {
  it('names a whole month by its month', () => {
    expect(briefingPeriodLabel(s('2026-10-01T00:00:00'), s('2026-11-01T00:00:00'))).toBe('October 2026');
  });
  it('names the last 30 days by their dates', () => {
    expect(briefingPeriodLabel(s('2026-10-15T09:00:00'), s('2026-11-14T09:00:00'))).toBe('15 October to 14 November 2026');
  });
  it('gives both years when the window crosses a year', () => {
    expect(briefingPeriodLabel(s('2025-12-10T09:00:00'), s('2026-01-09T09:00:00'))).toBe('10 December 2025 to 9 January 2026');
  });
});
