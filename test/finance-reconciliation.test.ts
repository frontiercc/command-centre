// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { buildReconciliation } from '@/lib/finance/reconciliation';
import type { SurfaceSummary, CodeTokens } from '@/lib/finance/chargeback';
import type { EnterpriseCost } from '@/lib/finance/enterprise-cost';

function tokens(): CodeTokens {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
}

describe('buildReconciliation', () => {
  it('returns unavailable when enterprise is null', () => {
    const surfaces: SurfaceSummary = {
      chat: { usd: null, tokens: tokens(), basis: 'dormant' },
      code: { usd: 100, tokens: tokens(), basis: 'estimate' },
      cowork: { usd: 50, tokens: tokens(), basis: 'actual' },
      total: { usd: 150, tokens: tokens() },
    };

    const result = buildReconciliation(surfaces, null);

    expect(result).toEqual({ available: false, perSurface: [], totalDeltaPct: null });
  });

  it('computes guarded per-surface and total delta% against Anthropic-reported spend', () => {
    // CCC estimate: chat dormant (null), code $100, cowork $50.
    const surfaces: SurfaceSummary = {
      chat: { usd: null, tokens: tokens(), basis: 'dormant' },
      code: { usd: 100, tokens: tokens(), basis: 'estimate' },
      cowork: { usd: 50, tokens: tokens(), basis: 'actual' },
      total: { usd: 150, tokens: tokens() },
    };

    // Anthropic-reported: chat $30 (but CCC has no chat figure to compare),
    // code $80 (CCC over-estimates by 25%), cowork $0 (zero-guard case).
    const enterprise: EnterpriseCost = {
      bySurface: {
        chat: { usd: 30, tokens: tokens() },
        code: { usd: 80, tokens: tokens() },
        cowork: { usd: 0, tokens: tokens() },
      },
      byModel: [],
      byType: { tokens: 0, webSearch: 0, codeExecution: 0 },
      contextWindow: { standardUsd: 0, longUsd: 0 },
      tokenTypes: { uncachedInput: 0, cachedInput: 0, cacheCreation: 0, output: 0 },
      fastModeUsd: 0,
      standardModeUsd: 0,
    };

    const result = buildReconciliation(surfaces, enterprise);

    expect(result.available).toBe(true);
    expect(result.perSurface).toHaveLength(3);

    const bySurface = Object.fromEntries(result.perSurface.map((s) => [s.surface, s]));

    // chat: cccUsd is null (dormant) → deltaPct null even though anthropicUsd is non-zero.
    expect(bySurface.chat).toEqual({ surface: 'chat', cccUsd: null, anthropicUsd: 30, deltaPct: null });

    // code: (100-80)/80*100 = 25.
    expect(bySurface.code.cccUsd).toBe(100);
    expect(bySurface.code.anthropicUsd).toBe(80);
    expect(bySurface.code.deltaPct).toBeCloseTo(25, 6);

    // cowork: anthropicUsd is 0 → deltaPct null (guarded, never Infinity/NaN).
    expect(bySurface.cowork).toEqual({ surface: 'cowork', cccUsd: 50, anthropicUsd: 0, deltaPct: null });

    // totalDeltaPct over summed totals: cccTotal = 0+100+50 = 150 (null treated as 0),
    // anthropicTotal = 30+80+0 = 110 → (150-110)/110*100 = 36.3636...
    expect(result.totalDeltaPct).toBeCloseTo(36.363636363636, 6);
  });

  it('returns null totalDeltaPct when the summed Anthropic total is zero', () => {
    const surfaces: SurfaceSummary = {
      chat: { usd: null, tokens: tokens(), basis: 'dormant' },
      code: { usd: 0, tokens: tokens(), basis: 'estimate' },
      cowork: { usd: 0, tokens: tokens(), basis: 'actual' },
      total: { usd: 0, tokens: tokens() },
    };
    const enterprise: EnterpriseCost = {
      bySurface: {
        chat: { usd: 0, tokens: tokens() },
        code: { usd: 0, tokens: tokens() },
        cowork: { usd: 0, tokens: tokens() },
      },
      byModel: [],
      byType: { tokens: 0, webSearch: 0, codeExecution: 0 },
      contextWindow: { standardUsd: 0, longUsd: 0 },
      tokenTypes: { uncachedInput: 0, cachedInput: 0, cacheCreation: 0, output: 0 },
      fastModeUsd: 0,
      standardModeUsd: 0,
    };

    const result = buildReconciliation(surfaces, enterprise);

    expect(result.available).toBe(true);
    expect(result.totalDeltaPct).toBeNull();
  });
});
