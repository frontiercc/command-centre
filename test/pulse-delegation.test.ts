// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Pure-builder tests for the Delegation View. No DB.
import { describe, it, expect } from 'vitest';
import {
  buildDepthSegments, buildBandSegments, buildThenVsNow, countDataWeeks, countLatestSegmentDataWeeks,
  type DelegationWeekRow,
} from '@/lib/pulse/delegation';

const WEEK = 7 * 86400;
// 8 consecutive Monday-UTC week starts (2026-06-01 is a Monday).
const W0 = Date.UTC(2026, 5, 1) / 1000;
const WEEKS = Array.from({ length: 8 }, (_, i) => W0 + i * WEEK);

function row(scopeId: string, week: number, t1: number, t2: number, t3: number): DelegationWeekRow {
  return { scopeId, periodStart: week, t1, t2, t3 };
}

describe('buildDepthSegments', () => {
  it('computes depth = (t2+t3)/total per week, one segment when no rubric change', () => {
    const rows = [row('u1', WEEKS[0], 8, 2, 0), row('u1', WEEKS[1], 5, 3, 2)];
    const segs = buildDepthSegments(rows, 'u1', WEEKS, []);
    expect(segs).toHaveLength(1);
    expect(segs[0].startsAtRubricBreak).toBe(false);
    expect(segs[0].points).toHaveLength(8);
    expect(segs[0].points[0]).toEqual({ weekStart: WEEKS[0], depth: 0.2 });
    expect(segs[0].points[1]).toEqual({ weekStart: WEEKS[1], depth: 0.5 });
  });

  it('weeks below the per-week event floor are null (gap), not zero', () => {
    const rows = [row('u1', WEEKS[0], 1, 1, 0)]; // 2 events < MIN_WEEK_EVENTS=3
    const segs = buildDepthSegments(rows, 'u1', WEEKS, []);
    expect(segs[0].points[0].depth).toBeNull();
  });

  it('absent weeks are null, and a floor of 0 disables the event floor (dept scope)', () => {
    const rows = [row('d1', WEEKS[2], 1, 1, 0)];
    const segs = buildDepthSegments(rows, 'd1', WEEKS, [], 0);
    expect(segs[0].points[1].depth).toBeNull();      // absent week
    expect(segs[0].points[2].depth).toBe(0.5);       // 2 events, floor disabled
  });

  it('ignores rows for other scopeIds', () => {
    const rows = [row('u2', WEEKS[0], 0, 0, 9)];
    const segs = buildDepthSegments(rows, 'u1', WEEKS, []);
    expect(segs[0].points.every(p => p.depth === null)).toBe(true);
  });

  it('splits into segments at a rubric change; the change week starts the new segment', () => {
    const rows = WEEKS.map(w => row('u1', w, 5, 5, 0));
    const changeAt = WEEKS[4] + 3600; // Tuesday-ish inside week 4
    const segs = buildDepthSegments(rows, 'u1', WEEKS, [changeAt]);
    expect(segs).toHaveLength(2);
    expect(segs[0].points.map(p => p.weekStart)).toEqual(WEEKS.slice(0, 4));
    expect(segs[1].points.map(p => p.weekStart)).toEqual(WEEKS.slice(4));
    expect(segs[0].startsAtRubricBreak).toBe(false);
    expect(segs[1].startsAtRubricBreak).toBe(true);
  });

  it('a rubric change before the window produces one segment; two changes produce three', () => {
    const rows = WEEKS.map(w => row('u1', w, 5, 5, 0));
    expect(buildDepthSegments(rows, 'u1', WEEKS, [W0 - WEEK])).toHaveLength(1);
    expect(buildDepthSegments(rows, 'u1', WEEKS, [WEEKS[2], WEEKS[5] + 60])).toHaveLength(3);
  });
});

describe('buildBandSegments', () => {
  it('returns tier shares per week, null-shares on empty weeks, segment split intact', () => {
    const rows = [row('d1', WEEKS[0], 6, 3, 1)];
    const segs = buildBandSegments(rows, 'd1', WEEKS, [WEEKS[4]]);
    expect(segs).toHaveLength(2);
    expect(segs[0].weeks[0]).toEqual({ weekStart: WEEKS[0], t1Share: 0.6, t2Share: 0.3, t3Share: 0.1 });
    expect(segs[0].weeks[1].t1Share).toBeNull();
  });
});

describe('buildThenVsNow', () => {
  const seg = (weeks: number[], depths: Array<number | null>, brk = false) => ({
    startsAtRubricBreak: brk,
    points: weeks.map((w, i) => ({ weekStart: w, depth: depths[i] })),
  });

  it('compares first-k vs last-k data-weeks of the LATEST segment only', () => {
    // 8 data-weeks rising 0.1..0.8 → k=4: then=mean(.1..4)=0.25, now=mean(.5..8)=0.65
    const s = seg(WEEKS, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
    const r = buildThenVsNow([s]);
    expect(r).not.toBeNull();
    expect(r!.then).toBeCloseTo(0.25, 5);
    expect(r!.now).toBeCloseTo(0.65, 5);
    expect(r!.deltaPp).toBeCloseTo(40, 5);
    expect(r!.arrow).toBe('up');
    expect(r!.dataWeeks).toBe(8);
  });

  it('nulls are skipped; k shrinks to floor(n/2); < 4 data-weeks → null', () => {
    // 5 data-weeks → k=2: then=mean(first 2), now=mean(last 2)
    const s = seg(WEEKS, [0.2, null, 0.2, 0.4, null, 0.6, 0.6, null]);
    const r = buildThenVsNow([s]);
    expect(r!.then).toBeCloseTo(0.2, 5);
    expect(r!.now).toBeCloseTo(0.6, 5);
    // 3 data-weeks → insufficient
    expect(buildThenVsNow([seg(WEEKS, [0.2, null, 0.3, null, 0.4, null, null, null])])).toBeNull();
  });

  it('uses only the segment after a rubric break, and |delta| <= 5pp is flat', () => {
    const old = seg(WEEKS.slice(0, 4), [0.9, 0.9, 0.9, 0.9]);
    const cur = seg(WEEKS.slice(4), [0.30, 0.31, 0.32, 0.33], true);
    const r = buildThenVsNow([old, cur]);
    expect(r!.then).toBeCloseTo(0.305, 5); // k=2 within the 4-data-week latest segment
    expect(r!.arrow).toBe('flat');
  });
});

describe('countDataWeeks', () => {
  it('counts non-null points across all segments', () => {
    const segs = buildDepthSegments(
      [{ scopeId: 'u1', periodStart: WEEKS[0], t1: 3, t2: 0, t3: 0 },
       { scopeId: 'u1', periodStart: WEEKS[5], t1: 0, t2: 3, t3: 0 }],
      'u1', WEEKS, [WEEKS[3]]);
    expect(countDataWeeks(segs)).toBe(2);
  });
});

describe('countLatestSegmentDataWeeks', () => {
  it('counts only the last segment\'s non-null points, not earlier segments', () => {
    // Pre-break week (WEEKS[0]) has data; post-break segment (WEEKS[3..]) has
    // one data-week (WEEKS[5]) — countDataWeeks would say 2, this says 1.
    const segs = buildDepthSegments(
      [{ scopeId: 'u1', periodStart: WEEKS[0], t1: 3, t2: 0, t3: 0 },
       { scopeId: 'u1', periodStart: WEEKS[5], t1: 0, t2: 3, t3: 0 }],
      'u1', WEEKS, [WEEKS[3]]);
    expect(countDataWeeks(segs)).toBe(2);
    expect(countLatestSegmentDataWeeks(segs)).toBe(1);
  });

  it('returns 0 for an empty segments array', () => {
    expect(countLatestSegmentDataWeeks([])).toBe(0);
  });

  it('returns 0 when the latest segment has no non-null points', () => {
    const segs = buildDepthSegments(
      [{ scopeId: 'u1', periodStart: WEEKS[0], t1: 3, t2: 0, t3: 0 }],
      'u1', WEEKS, [WEEKS[3]]);
    expect(countLatestSegmentDataWeeks(segs)).toBe(0);
  });
});
