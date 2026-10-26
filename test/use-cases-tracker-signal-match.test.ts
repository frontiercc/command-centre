// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { signalMatches } from '@/lib/usecases/tracker';

describe('signalMatches', () => {
  const set = new Set(['month-end-variance-commentary', 'anthropic-skills:xlsx']);
  it('matches exact names', () => {
    expect(signalMatches(set, 'month-end-variance-commentary')).toBe(true);
    expect(signalMatches(set, 'anthropic-skills:xlsx')).toBe(true);
  });
  it('matches a marketplace-prefixed form of a bare rule name', () => {
    expect(signalMatches(set, 'acme-library:month-end-variance-commentary')).toBe(true);
  });
  it('does not match a different name, a substring, or a prefix-only hit', () => {
    expect(signalMatches(set, 'variance-commentary')).toBe(false);
    expect(signalMatches(set, 'month-end-variance-commentary-v2')).toBe(false);
    expect(signalMatches(set, 'xlsx')).toBe(false);   // rule is the prefixed form; telemetry bare — no match (rule owner chose the full name)
  });
  it('is case-insensitive', () => {
    expect(signalMatches(set, 'Month-End-Variance-Commentary')).toBe(true);
  });
});

describe('signalMatches fast path', () => {
  // A set that refuses iteration: an exact hit must be answered by set.has alone.
  class NoIterSet extends Set<string> {
    [Symbol.iterator](): SetIterator<string> { throw new Error('iterated'); }
    values(): SetIterator<string> { throw new Error('iterated'); }
  }
  it('an exact hit short-circuits on set.has, without walking a large set', () => {
    const big = new NoIterSet(Array.from({ length: 50_000 }, (_, i) => `skill-${i}`));
    expect(signalMatches(big, 'skill-49999')).toBe(true);
    expect(signalMatches(big, 'mkt:skill-123')).toBe(true);   // bare suffix hit, still no iteration
  });
  it('an exact miss still falls back to the case-insensitive pass', () => {
    expect(signalMatches(new Set(['Month-End-Variance']), 'month-end-variance')).toBe(true);
    expect(signalMatches(new Set(['month-end-variance']), 'other')).toBe(false);
  });
});
