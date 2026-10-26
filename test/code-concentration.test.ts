// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import {
  computeSpendConcentration,
  MIN_SPENDERS_FOR_CONCENTRATION,
  CONCENTRATION_TIERS,
} from '@/lib/pulse/code/concentration';

describe('computeSpendConcentration', () => {
  it('returns null below the minimum spender count', () => {
    const tooFew = Array(MIN_SPENDERS_FOR_CONCENTRATION - 1).fill(100);
    expect(computeSpendConcentration(tooFew)).toBeNull();
  });

  it('returns null when total spend is zero', () => {
    expect(computeSpendConcentration([0, 0, 0, 0, 0, 0])).toBeNull();
  });

  it('ignores zero/negative spenders when counting', () => {
    // 4 real spenders + noise → still below threshold of 5 → null
    expect(computeSpendConcentration([10, 10, 10, 10, 0, -5])).toBeNull();
  });

  it('computes cumulative top-N shares against the total', () => {
    // 12 spenders, descending; total = 100 (sum below)
    const spends = [30, 20, 15, 10, 8, 5, 4, 3, 2, 1, 1, 1]; // sum = 100
    const r = computeSpendConcentration(spends)!;
    expect(r).not.toBeNull();
    expect(r.spenderCount).toBe(12);
    expect(r.totalSpend).toBe(100);
    const byTier = Object.fromEntries(r.tiers.map(t => [t.topN, t.share]));
    expect(byTier[1]).toBeCloseTo(0.30, 5);            // top 1 = 30/100
    expect(byTier[5]).toBeCloseTo(0.83, 5);            // 30+20+15+10+8 = 83
    expect(byTier[10]).toBeCloseTo(0.98, 5);           // first 10 sum to 98
  });

  it('order-independent: unsorted input ranks before summing', () => {
    const sorted = computeSpendConcentration([30, 20, 15, 10, 8, 5, 4, 3, 2, 1, 1, 1])!;
    const shuffled = computeSpendConcentration([1, 8, 30, 2, 15, 1, 20, 4, 10, 3, 5, 1])!;
    expect(shuffled.tiers).toEqual(sorted.tiers);
  });

  it('only emits tiers strictly smaller than the spender count (no "top 10 of 6")', () => {
    const six = [60, 20, 10, 5, 3, 2]; // 6 spenders
    const r = computeSpendConcentration(six)!;
    const tierNs = r.tiers.map(t => t.topN);
    expect(tierNs).toContain(1);
    expect(tierNs).toContain(5);
    expect(tierNs).not.toContain(10); // 10 is not < 6
    // top 1 share = 60/100
    expect(r.tiers.find(t => t.topN === 1)!.share).toBeCloseTo(0.6, 5);
  });

  it('declared tiers match the native-dashboard set', () => {
    expect([...CONCENTRATION_TIERS]).toEqual([1, 5, 10]);
  });
});
