// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Spend Review keeps one row per model: a dated or provider-decorated name and its plain
// name (both "Claude Haiku 4.5") are one model, unless an admin priced them differently.
import { describe, it, expect } from 'vitest';
import { modelKey } from '@/lib/finance/spend-review';
import { DEFAULT_RATES } from '@/lib/pulse/code/rates';

describe('modelKey', () => {
  it('folds a dated name into the plain one', () => {
    expect(modelKey('claude-haiku-4-5-20251001', DEFAULT_RATES)).toBe('claude-haiku-4-5');
    expect(modelKey('claude-sonnet-4-5-20250929', DEFAULT_RATES)).toBe('claude-sonnet-4-5');
    expect(modelKey('claude-haiku-4-5', DEFAULT_RATES)).toBe('claude-haiku-4-5');
  });

  it('folds Bedrock and Vertex names into the plain one', () => {
    expect(modelKey('us.anthropic.claude-haiku-4-5-20251001-v1:0', DEFAULT_RATES)).toBe('claude-haiku-4-5');
    expect(modelKey('claude-sonnet-4-5@20250929', DEFAULT_RATES)).toBe('claude-sonnet-4-5');
  });

  it('keeps a dated name with no plain entry, an unpriced name, and OpenAI names as they are', () => {
    expect(modelKey('claude-3-5-haiku-20241022', DEFAULT_RATES)).toBe('claude-3-5-haiku-20241022');
    expect(modelKey('some-new-model', DEFAULT_RATES)).toBe('some-new-model');
    expect(modelKey('gpt-6.1-sol', DEFAULT_RATES)).toBe('gpt-6.1-sol');
  });

  it('keeps a name an admin priced differently on its own row', () => {
    const rates = { ...DEFAULT_RATES, 'claude-haiku-4-5-20251001': { in: 2, out: 10, cacheWrite: 2.5, cacheRead: 0.2 } };
    expect(modelKey('claude-haiku-4-5-20251001', rates)).toBe('claude-haiku-4-5-20251001');
  });
});
