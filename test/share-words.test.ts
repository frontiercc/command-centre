// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// shareWords and sharePair (components/dashboard/QuestionCard.tsx): a share as a percentage,
// "all" and "none" only at the ends, never a word fraction like "three in four".
import { describe, it, expect } from 'vitest';
import { shareWords, sharePair } from '@/components/dashboard/QuestionCard';

describe('shareWords', () => {
  it('says all and none at the ends', () => {
    expect(shareWords(1)).toBe('all');
    expect(shareWords(0)).toBe('none');
  });
  it('gives a percentage in between, never rounding to the ends', () => {
    expect(shareWords(0.73)).toBe('73%');
    expect(shareWords(0.5)).toBe('50%');
    expect(shareWords(0.999)).toBe('99%');
    expect(shareWords(0.001)).toBe('1%');
  });
});

describe('sharePair', () => {
  it('gives both shares as percentages, in the order asked', () => {
    expect(sharePair(0.6, 0.75)).toEqual(['60%', '75%']);
    expect(sharePair(1, 0)).toEqual(['100%', '0%']);
  });
});
