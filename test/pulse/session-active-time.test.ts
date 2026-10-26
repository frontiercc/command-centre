// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { activeSecondsFromTimestamps, IDLE_GAP_SECS } from '@/lib/pulse/session-active-time';

describe('activeSecondsFromTimestamps', () => {
  it('returns 0 for an empty timestamp list', () => {
    expect(activeSecondsFromTimestamps([])).toBe(0);
  });

  it('returns 0 for a single-event session', () => {
    expect(activeSecondsFromTimestamps([1_000_000])).toBe(0);
  });

  it('sums a 10-minute gap between two events', () => {
    const t0 = 1_000_000;
    expect(activeSecondsFromTimestamps([t0, t0 + 600])).toBe(600);
  });

  it('a gap larger than the idle threshold contributes nothing', () => {
    const t0 = 1_000_000;
    const twoDaysLater = t0 + 2 * 24 * 60 * 60;
    expect(activeSecondsFromTimestamps([t0, twoDaysLater])).toBe(0);
  });

  it('sums only the small gaps in a session with one long idle gap', () => {
    const t0 = 1_000_000;
    // 5 min, then a 2-day idle gap, then 3 min — only the small gaps count.
    const timestamps = [t0, t0 + 300, t0 + 300 + 2 * 24 * 60 * 60, t0 + 300 + 2 * 24 * 60 * 60 + 180];
    expect(activeSecondsFromTimestamps(timestamps)).toBe(300 + 180);
  });

  it('sorts unsorted input before computing gaps', () => {
    const t0 = 1_000_000;
    // Passed out of order — result must be identical to the sorted case.
    expect(activeSecondsFromTimestamps([t0 + 600, t0])).toBe(600);
  });

  it('treats equal (duplicate) timestamps as a harmless zero-length gap', () => {
    const t0 = 1_000_000;
    expect(activeSecondsFromTimestamps([t0, t0, t0 + 100])).toBe(100);
  });

  it('a gap exactly at the idle threshold counts as active (inclusive boundary)', () => {
    const t0 = 1_000_000;
    expect(activeSecondsFromTimestamps([t0, t0 + IDLE_GAP_SECS])).toBe(IDLE_GAP_SECS);
  });

  it('a gap one second past the idle threshold contributes nothing', () => {
    const t0 = 1_000_000;
    expect(activeSecondsFromTimestamps([t0, t0 + IDLE_GAP_SECS + 1])).toBe(0);
  });

  it('honours a custom idleGapS override', () => {
    const t0 = 1_000_000;
    expect(activeSecondsFromTimestamps([t0, t0 + 120], 60)).toBe(0);
    expect(activeSecondsFromTimestamps([t0, t0 + 120], 120)).toBe(120);
  });
});
