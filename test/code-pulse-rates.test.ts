// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getConfigValueMock = vi.fn();
vi.mock('@/lib/config', () => ({
  getConfigValue: (key: string) => getConfigValueMock(key),
}));

import {
  getCodeModelRates, priceTokens, normalizeModelId, DEFAULT_RATES,
  isEstimatedPricing, spendIsPartlyEstimated,
} from '@/lib/pulse/code/rates';

beforeEach(() => {
  getConfigValueMock.mockReset();
  getConfigValueMock.mockReturnValue('{}');
});

describe('getCodeModelRates', () => {
  it('returns defaults when config is empty', async () => {
    const rates = await getCodeModelRates();
    expect(rates['claude-fable-5']).toEqual({ in: 10, out: 50, cacheWrite: 12.5, cacheRead: 1 });
    expect(rates['claude-haiku-4-5'].in).toBe(1);
  });

  it('config overrides defaults and adds new models', async () => {
    getConfigValueMock.mockReturnValue(JSON.stringify({
      'claude-fable-5': { in: 8, out: 40, cacheWrite: 10, cacheRead: 0.8 },
      'custom-model': { in: 2, out: 4, cacheWrite: 2.5, cacheRead: 0.2 },
    }));
    const rates = await getCodeModelRates();
    expect(rates['claude-fable-5'].in).toBe(8);
    expect(rates['custom-model'].out).toBe(4);
    expect(rates['claude-sonnet-4-6'].in).toBe(3); // default retained
  });

  it('falls back to defaults on malformed JSON', async () => {
    getConfigValueMock.mockReturnValue('{not json');
    expect(await getCodeModelRates()).toEqual({ ...DEFAULT_RATES });
  });

  it('falls back to defaults on non-object JSON', async () => {
    getConfigValueMock.mockReturnValue('[1,2,3]');
    expect(await getCodeModelRates()).toEqual({ ...DEFAULT_RATES });
  });
});

describe('priceTokens', () => {
  const usage = {
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cacheCreationTokens: 200_000,
    cacheReadTokens: 2_000_000,
  };

  it('prices a known model from all four token classes', async () => {
    // fable-5: 1M×$10 + 0.1M×$50 + 0.2M×$12.5 + 2M×$1 = 10 + 5 + 2.5 + 2 = 19.5
    const rates = await getCodeModelRates();
    expect(priceTokens('claude-fable-5', usage, rates)).toBeCloseTo(19.5, 6);
  });

  it('returns null (not zero) for an unknown model', async () => {
    const rates = await getCodeModelRates();
    expect(priceTokens('mystery-model-9000', usage, rates)).toBeNull();
  });

  it('prices zero usage as zero, not null', async () => {
    const rates = await getCodeModelRates();
    expect(priceTokens('claude-haiku-4-5', {
      inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    }, rates)).toBe(0);
  });

  it('prices Bedrock provider-decorated IDs via normalisation (estimate at list rate)', async () => {
    // global endpoint, base, and CRIS regional all resolve to the canonical opus-4-6 rate
    const rates = await getCodeModelRates();
    const expected = priceTokens('claude-opus-4-6', usage, rates);
    expect(expected).not.toBeNull();
    expect(priceTokens('global.anthropic.claude-opus-4-6-v1', usage, rates)).toBeCloseTo(expected!, 6);
    expect(priceTokens('anthropic.claude-opus-4-6-v1', usage, rates)).toBeCloseTo(expected!, 6);
    expect(priceTokens('us.anthropic.claude-opus-4-6-v1', usage, rates)).toBeCloseTo(expected!, 6);
  });

  it('resolves a Bedrock ID carrying a date + version suffix when the dated key exists', async () => {
    // us.anthropic.claude-haiku-4-5-20251001-v1:0 -> claude-haiku-4-5-20251001 (a DEFAULT_RATES key)
    const rates = await getCodeModelRates();
    const expected = priceTokens('claude-haiku-4-5-20251001', usage, rates);
    expect(expected).not.toBeNull();
    expect(priceTokens('us.anthropic.claude-haiku-4-5-20251001-v1:0', usage, rates)).toBeCloseTo(expected!, 6);
  });

  it('an exact provider-ID rate entry overrides the normalised list rate', async () => {
    getConfigValueMock.mockReturnValue(JSON.stringify({
      // an admin supplies real AWS Bedrock pricing for the exact provider ID
      'us.anthropic.claude-opus-4-6-v1': { in: 100, out: 100, cacheWrite: 100, cacheRead: 100 },
    }));
    const rates = await getCodeModelRates();
    // exact key wins; not the normalised claude-opus-4-6 list rate
    expect(priceTokens('us.anthropic.claude-opus-4-6-v1', {
      inputTokens: 1_000_000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    }, rates)).toBeCloseTo(100, 6);
  });

  it('still returns null for an unknown model after normalisation', async () => {
    const rates = await getCodeModelRates();
    expect(priceTokens('us.anthropic.mystery-model-9000-v1:0', usage, rates)).toBeNull();
  });
});

describe('normalizeModelId', () => {
  it('strips Bedrock global/region prefix, provider prefix, and version suffix', () => {
    expect(normalizeModelId('global.anthropic.claude-opus-4-6-v1')).toBe('claude-opus-4-6');
    expect(normalizeModelId('us.anthropic.claude-opus-4-6-v1')).toBe('claude-opus-4-6');
    expect(normalizeModelId('anthropic.claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(normalizeModelId('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('claude-haiku-4-5-20251001');
  });

  it('strips a Vertex @-version suffix', () => {
    expect(normalizeModelId('claude-sonnet-4-5@20250929')).toBe('claude-sonnet-4-5');
  });

  it('leaves an undecorated canonical ID unchanged', () => {
    expect(normalizeModelId('claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(normalizeModelId('claude-fable-5')).toBe('claude-fable-5');
  });
});

describe('isEstimatedPricing', () => {
  it('is false for a model with an exact rate entry', async () => {
    const rates = await getCodeModelRates();
    expect(isEstimatedPricing('claude-haiku-4-5-20251001', rates)).toBe(false);
  });

  it('is true for a model priced only via the normalised fallback', async () => {
    const rates = await getCodeModelRates();
    expect(isEstimatedPricing('us.anthropic.claude-opus-4-6-v1', rates)).toBe(true);
  });

  it('is false for a model with no price at all (not estimated, just unpriced)', async () => {
    const rates = await getCodeModelRates();
    expect(isEstimatedPricing('mystery-model-9000', rates)).toBe(false);
  });

  it('is false once an admin adds the exact decorated ID to the rate table', async () => {
    const rates = await getCodeModelRates();
    rates['us.anthropic.claude-opus-4-6-v1'] = { in: 100, out: 100, cacheWrite: 100, cacheRead: 100 };
    expect(isEstimatedPricing('us.anthropic.claude-opus-4-6-v1', rates)).toBe(false);
  });
});

describe('spendIsPartlyEstimated', () => {
  it('is false when every model in the window is exactly priced', async () => {
    const rates = await getCodeModelRates();
    expect(spendIsPartlyEstimated(['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'], rates)).toBe(false);
  });

  it('is true when at least one model only resolves via the normalised fallback', async () => {
    const rates = await getCodeModelRates();
    expect(spendIsPartlyEstimated(['claude-haiku-4-5-20251001', 'us.anthropic.claude-opus-4-6-v1'], rates)).toBe(true);
  });

  it('is false for an empty model list', async () => {
    const rates = await getCodeModelRates();
    expect(spendIsPartlyEstimated([], rates)).toBe(false);
  });

  it('is false when every model is entirely unpriced (no fallback hit)', async () => {
    const rates = await getCodeModelRates();
    expect(spendIsPartlyEstimated(['mystery-model-9000', 'another-unknown'], rates)).toBe(false);
  });
});
