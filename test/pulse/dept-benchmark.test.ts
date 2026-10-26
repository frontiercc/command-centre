// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Department benchmark (metric-refinements §4). Spread around the org median,
// NOT a league table. Support flag fires on an ABSOLUTE floor (never
// below-median, which would condemn half the org every period). Small depts
// (< minSize active members) are "too small to compare".
import { describe, it, expect } from 'vitest';
import { buildDeptBenchmark } from '@/lib/pulse/dept-benchmark';

describe('buildDeptBenchmark (§4)', () => {
  const depts = [
    { department: 'Alpha', member_count: 5, avg_dds: 1.2 },
    { department: 'Bravo', member_count: 6, avg_dds: 1.8 },
    { department: 'Charlie', member_count: 4, avg_dds: 1.5 },
    { department: 'Delta', member_count: 2, avg_dds: 3.0 },  // too small
    { department: 'Echo', member_count: 5, avg_dds: null },   // no DDS
  ];

  it('takes the median over eligible depts only (>= minSize, non-null)', () => {
    const b = buildDeptBenchmark(depts, { floor: 1.4, minSize: 4 });
    expect(b.median).toBeCloseTo(1.5, 5); // median(1.2, 1.8, 1.5)
  });

  it('flags support on the absolute floor, not below-median', () => {
    const b = buildDeptBenchmark(depts, { floor: 1.4, minSize: 4 });
    const byName = Object.fromEntries(b.rows.map(r => [r.department, r]));
    expect(byName['Alpha'].needsSupport).toBe(true);   // 1.2 < 1.4
    expect(byName['Charlie'].needsSupport).toBe(false); // 1.5 >= 1.4 (and it's below the mean but NOT flagged)
    expect(byName['Bravo'].needsSupport).toBe(false);
  });

  it('marks small departments too-small and never flags or positions them', () => {
    const b = buildDeptBenchmark(depts, { floor: 1.4, minSize: 4 });
    const delta = b.rows.find(r => r.department === 'Delta')!;
    expect(delta.tooSmall).toBe(true);
    expect(delta.needsSupport).toBe(false);
    expect(delta.deltaFromMedian).toBeNull();
  });

  it('positions eligible depts as a delta from the median', () => {
    const b = buildDeptBenchmark(depts, { floor: 1.4, minSize: 4 });
    const byName = Object.fromEntries(b.rows.map(r => [r.department, r]));
    expect(byName['Alpha'].deltaFromMedian).toBeCloseTo(-0.3, 5);
    expect(byName['Bravo'].deltaFromMedian).toBeCloseTo(0.3, 5);
  });

  it('a healthy org can have zero flagged departments (floor is absolute)', () => {
    const b = buildDeptBenchmark(depts, { floor: 0.5, minSize: 4 });
    expect(b.rows.filter(r => r.needsSupport).length).toBe(0);
  });

  it('null median when no department is eligible', () => {
    const b = buildDeptBenchmark([{ department: 'X', member_count: 2, avg_dds: 2 }], { floor: 1.4, minSize: 4 });
    expect(b.median).toBeNull();
  });
});
