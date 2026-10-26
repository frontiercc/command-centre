// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { computeCostByType, type ModelSpend } from '@/lib/finance/model-efficiency';
import type { ModelRates, TokenUsage } from '@/lib/pulse/code/rates';

describe('cost by token class (allocated by list-rate weights)', () => {
  it('for a Code-style model where measured spend == priceTokens, gives exact class $', () => {
    // rates $3/MTok input, $15 output, $3.75 cache-write, $0.30 cache-read; 1M tokens each class
    const usageByModel = new Map<string, TokenUsage>([
      ['claude-sonnet-5', { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationTokens: 1_000_000, cacheReadTokens: 1_000_000 }],
    ]);
    const rates: ModelRates = { 'claude-sonnet-5': { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.30 } };
    const byModel: ModelSpend[] = [{ model: 'claude-sonnet-5', tier: 3, spendUsd: 22.05, tokens: 4_000_000 }]; // == Σ priceTokens

    const c = computeCostByType(byModel, usageByModel, rates);

    expect(c.inputUsd).toBeCloseTo(3, 5);
    expect(c.outputUsd).toBeCloseTo(15, 5);
    expect(c.cacheWriteUsd).toBeCloseTo(3.75, 5);
    expect(c.cacheReadUsd).toBeCloseTo(0.30, 5);
    expect(c.unclassifiedUsd).toBe(0);
    expect(c.inputUsd + c.outputUsd + c.cacheWriteUsd + c.cacheReadUsd + c.unclassifiedUsd).toBeCloseTo(22.05, 5);
  });

  it('reconciles to MEASURED spend for a Cowork-style model (measured != priceTokens)', () => {
    const usageByModel = new Map<string, TokenUsage>([
      ['claude-sonnet-5', { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationTokens: 1_000_000, cacheReadTokens: 1_000_000 }],
    ]);
    const rates: ModelRates = { 'claude-sonnet-5': { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.30 } }; // Σ priceTokens = 22.05
    const byModel: ModelSpend[] = [{ model: 'claude-sonnet-5', tier: 3, spendUsd: 10, tokens: 4_000_000 }]; // MEASURED, differs from 22.05

    const c = computeCostByType(byModel, usageByModel, rates);

    // classes must sum to the MEASURED 10, apportioned by the 22.05 weights
    expect(c.inputUsd + c.outputUsd + c.cacheWriteUsd + c.cacheReadUsd + c.unclassifiedUsd).toBeCloseTo(10, 5);
    expect(c.outputUsd).toBeCloseTo(10 * (15 / 22.05), 5);
    expect(c.unclassifiedUsd).toBe(0);
  });

  it('excludes unpriced models (no rate) from cost by type entirely, including unclassifiedUsd', () => {
    const usageByModel = new Map<string, TokenUsage>([
      ['unknown-model', { inputTokens: 9_000_000, outputTokens: 9_000_000, cacheCreationTokens: 0, cacheReadTokens: 0 }],
    ]);
    const byModel: ModelSpend[] = [{ model: 'unknown-model', tier: 0, spendUsd: 0, tokens: 18_000_000 }];
    const rates: ModelRates = {}; // no entry for unknown-model

    const c = computeCostByType(byModel, usageByModel, rates);

    expect(c.inputUsd).toBe(0);
    expect(c.outputUsd).toBe(0);
    expect(c.cacheWriteUsd).toBe(0);
    expect(c.cacheReadUsd).toBe(0);
    expect(c.unclassifiedUsd).toBe(0);
  });

  it('a priced model with usage but a zero-denominator rate (all rates zero) lands in unclassifiedUsd, not dropped', () => {
    const usageByModel = new Map<string, TokenUsage>([
      ['free-model', { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationTokens: 0, cacheReadTokens: 0 }],
    ]);
    const byModel: ModelSpend[] = [{ model: 'free-model', tier: 1, spendUsd: 5, tokens: 2_000_000 }];
    const rates: ModelRates = { 'free-model': { in: 0, out: 0, cacheWrite: 0, cacheRead: 0 } };

    const c = computeCostByType(byModel, usageByModel, rates);

    expect(c.inputUsd).toBe(0);
    expect(c.outputUsd).toBe(0);
    expect(c.cacheWriteUsd).toBe(0);
    expect(c.cacheReadUsd).toBe(0);
    expect(c.unclassifiedUsd).toBe(5);
  });

  it('sums across multiple priced models', () => {
    const usageByModel = new Map<string, TokenUsage>([
      ['model-a', { inputTokens: 1_000_000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }],
      ['model-b', { inputTokens: 0, outputTokens: 1_000_000, cacheCreationTokens: 0, cacheReadTokens: 0 }],
    ]);
    const rates: ModelRates = {
      'model-a': { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.30 },
      'model-b': { in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.10 },
    };
    const byModel: ModelSpend[] = [
      { model: 'model-a', tier: 1, spendUsd: 3, tokens: 1_000_000 },
      { model: 'model-b', tier: 2, spendUsd: 5, tokens: 1_000_000 },
    ];

    const c = computeCostByType(byModel, usageByModel, rates);

    expect(c.inputUsd).toBeCloseTo(3, 5);
    expect(c.outputUsd).toBeCloseTo(5, 5);
    expect(c.cacheWriteUsd).toBeCloseTo(0, 5);
    expect(c.cacheReadUsd).toBeCloseTo(0, 5);
    expect(c.unclassifiedUsd).toBe(0);
  });

  it('a priced model with spend but NO usage row at all (e.g. Cowork pre-cutover, token_usage never persisted) has its full spend land in unclassifiedUsd', () => {
    const usageByModel = new Map<string, TokenUsage>(); // no entry for the model at all
    const rates: ModelRates = { 'claude-sonnet-5': { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.30 } };
    const byModel: ModelSpend[] = [{ model: 'claude-sonnet-5', tier: 1, spendUsd: 42, tokens: 0 }];

    const c = computeCostByType(byModel, usageByModel, rates);

    expect(c.inputUsd).toBe(0);
    expect(c.outputUsd).toBe(0);
    expect(c.cacheWriteUsd).toBe(0);
    expect(c.cacheReadUsd).toBe(0);
    expect(c.unclassifiedUsd).toBe(42);
    expect(c.inputUsd + c.outputUsd + c.cacheWriteUsd + c.cacheReadUsd + c.unclassifiedUsd).toBe(42);
  });

  it('mixed: one model with usable usage + one priced-but-usage-less model reconciles to the grand total, classes come only from the first', () => {
    const usageByModel = new Map<string, TokenUsage>([
      ['claude-sonnet-5', { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationTokens: 1_000_000, cacheReadTokens: 1_000_000 }],
      // 'claude-haiku-4-5' deliberately has no usage row (pre-cutover Cowork month).
    ]);
    const rates: ModelRates = {
      'claude-sonnet-5': { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.30 }, // Σ priceTokens = 22.05
      'claude-haiku-4-5': { in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.10 },
    };
    const byModel: ModelSpend[] = [
      { model: 'claude-sonnet-5', tier: 1, spendUsd: 22.05, tokens: 4_000_000 },
      { model: 'claude-haiku-4-5', tier: 2, spendUsd: 8, tokens: 0 }, // measured cost_usd, no usable usage
    ];

    const c = computeCostByType(byModel, usageByModel, rates);

    // The four classes come ONLY from claude-sonnet-5 (exact reproduction, as in test 1).
    expect(c.inputUsd).toBeCloseTo(3, 5);
    expect(c.outputUsd).toBeCloseTo(15, 5);
    expect(c.cacheWriteUsd).toBeCloseTo(3.75, 5);
    expect(c.cacheReadUsd).toBeCloseTo(0.30, 5);
    // claude-haiku-4-5's whole measured spend is unclassified.
    expect(c.unclassifiedUsd).toBeCloseTo(8, 5);
    // Grand total reconciles to Σ spendUsd (22.05 + 8 = 30.05).
    const grandTotal = c.inputUsd + c.outputUsd + c.cacheWriteUsd + c.cacheReadUsd + c.unclassifiedUsd;
    expect(grandTotal).toBeCloseTo(30.05, 5);
  });
});
