// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { computeCacheEfficiency } from '@/lib/finance/model-efficiency';

describe('cache efficiency', () => {
  it('is cacheRead / (input + cacheCreation + cacheRead), output excluded', () => {
    const r = computeCacheEfficiency({ inputTokens: 100, outputTokens: 999, cacheCreationTokens: 100, cacheReadTokens: 800 });
    // 800 / (100 + 100 + 800) = 0.8
    expect(r.ratio).toBeCloseTo(0.8, 5);
    expect(r.cacheReadTokens).toBe(800);
    expect(r.inputSideTokens).toBe(1000);
  });

  it('returns null (not 0) when there are no input-side tokens', () => {
    const r = computeCacheEfficiency({ inputTokens: 0, outputTokens: 500, cacheCreationTokens: 0, cacheReadTokens: 0 });
    expect(r.ratio).toBeNull();
  });
});
