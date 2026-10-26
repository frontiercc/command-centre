// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { tightenRecommendation } from '@/lib/anthropic/recommendation-text';

describe('tightenRecommendation', () => {
  it('keeps a short two-sentence recommendation as it is', () => {
    const d = '30 alerts are open and 13 are high severity. Close the ones already handled.';
    expect(tightenRecommendation(d)).toBe(d);
  });

  it('drops everything after the second sentence', () => {
    const d = 'Six intent alerts are open. Review each in context. If false positives are high, refine the categories.';
    expect(tightenRecommendation(d)).toBe('Six intent alerts are open. Review each in context.');
  });

  it('falls back to the first sentence when two still run long', () => {
    const long = 'Three high-severity policy alerts (AWS keys, national insurance numbers) and two medium-severity ones show users typing sensitive data into Claude conversations this week.';
    const d = `${long} Add a clear data handling reminder to onboarding and consider a short team message on what must never be shared with Claude.`;
    expect(tightenRecommendation(d)).toBe(long);
  });

  it('turns em and en dashes into commas', () => {
    expect(tightenRecommendation('Spend rose — mostly on Opus. Review it.')).toBe('Spend rose, mostly on Opus. Review it.');
  });

  it('does not end a sentence at "e.g." or "etc."', () => {
    const d = 'Two intent alerts are open. Review whether they reflect legitimate work (e.g. testing access controls). Then refine the categories.';
    expect(tightenRecommendation(d)).toBe('Two intent alerts are open. Review whether they reflect legitimate work (e.g. testing access controls).');
  });

  it('keeps a decimal number intact', () => {
    expect(tightenRecommendation('Cost per session is $0.13 this week. Keep an eye on it.')).toBe('Cost per session is $0.13 this week. Keep an eye on it.');
  });
});
