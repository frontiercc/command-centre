// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import {
  computeHoursRecovered, computeDollarsRecovered, sumMeasuredSessions,
  WORKING_HOURS_PER_YEAR,
} from '@/lib/usecases/value';
import type { WeekActivity } from '@/lib/usecases/weeks';

const cal = { minutesPerSession: 30, loadedCompAnnual: 90000 };

function wk(sessionCount: number): WeekActivity {
  return { weekStart: 0, distinctUsers: 0, sessionCount, matchedMessages: 0, latestTier: null, lastSeenAt: null };
}

describe('use-case value math', () => {
  it('hours = sessions * minutes / 60', () => {
    expect(computeHoursRecovered(240, cal)).toBe(120); // 240 * 30 / 60
  });

  it('dollars = hours * loadedComp / working hours', () => {
    expect(WORKING_HOURS_PER_YEAR).toBe(1800);
    expect(computeDollarsRecovered(120, cal)).toBe(6000); // 120 * (90000/1800)=50
  });

  it('sums only the weeks present (absent weeks contribute nothing)', () => {
    expect(sumMeasuredSessions([wk(10), wk(0), wk(5)])).toBe(15);
    expect(sumMeasuredSessions([])).toBe(0);
  });

  it('never fabricates value from empty input', () => {
    expect(computeHoursRecovered(0, cal)).toBe(0);
    expect(computeDollarsRecovered(0, cal)).toBe(0);
  });
});
