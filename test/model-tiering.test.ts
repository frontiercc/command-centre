// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { modelPrice, rankModelsByPrice, nextCheaperInUse, estimateCeilingUsd } from '@/lib/finance/model-tiering';
import { DEFAULT_RATES } from '@/lib/pulse/code/rates';

describe('model-tiering', () => {
  it('ranks priced models most-expensive first, drops unpriced', () => {
    const ranked = rankModelsByPrice(
      ['claude-haiku-4-5', 'unknown-model', 'claude-opus-4-8', 'claude-sonnet-4-6'],
      DEFAULT_RATES,
    );
    expect(ranked).toEqual(['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5']);
  });

  it('nextCheaperInUse returns the next lower-priced model actually in use', () => {
    expect(nextCheaperInUse('claude-opus-4-8', ['claude-opus-4-8', 'claude-sonnet-4-6'], DEFAULT_RATES))
      .toBe('claude-sonnet-4-6');
    expect(nextCheaperInUse('claude-opus-4-8', ['claude-opus-4-8'], DEFAULT_RATES)).toBeNull();
  });

  it('estimateCeilingUsd reprices per token class and is positive', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationTokens: 0, cacheReadTokens: 0 };
    // opus in5/out25 = $30 ; sonnet in3/out15 = $18 ; ceiling = 12
    expect(estimateCeilingUsd(usage, 'claude-opus-4-8', 'claude-sonnet-4-6', DEFAULT_RATES)).toBeCloseTo(12, 5);
  });

  it('estimateCeilingUsd returns null when target unpriced', () => {
    const usage = { inputTokens: 1000, outputTokens: 1000, cacheCreationTokens: 0, cacheReadTokens: 0 };
    expect(estimateCeilingUsd(usage, 'claude-opus-4-8', 'mystery', DEFAULT_RATES)).toBeNull();
  });
});
