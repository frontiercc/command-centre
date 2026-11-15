// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// shareWords (components/dashboard/QuestionCard.tsx): a share as plain words, "all" and "none" at
// the ends and "nearly all" and "very few" only in between.
import { describe, it, expect } from 'vitest';
import { shareWords } from '@/components/dashboard/QuestionCard';

describe('shareWords', () => {
  it('says all and none at the ends', () => {
    expect(shareWords(1)).toBe('all');
    expect(shareWords(0)).toBe('none');
  });
  it('keeps nearly all and very few for the ranges in between', () => {
    expect(shareWords(0.9)).toBe('nearly all');
    expect(shareWords(0.99)).toBe('nearly all');
    expect(shareWords(0.1)).toBe('very few');
    expect(shareWords(0.01)).toBe('very few');
  });
  it('keeps the plain fractions', () => {
    expect(shareWords(0.5)).toBe('half');
    expect(shareWords(0.66)).toBe('two in three');
    expect(shareWords(0.55)).toBe('55%');
  });
});
