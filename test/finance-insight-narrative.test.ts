// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { generateInsightNarrative } from '@/lib/finance/insight-narrative';
import type { InsightFacts } from '@/lib/finance/insights';

const facts: InsightFacts = {
  biggestMover: { centre: 'Engineering', deltaUsd: 1234.56, deltaPct: 25.3, atPace: false },
  concentration: { topCentrePct: 42.1, topUsersPct: 61 },
  projection: { projectedUsd: 5000, priorUsd: 4000, vsPriorPct: 25 },
  dataQuality: { unallocatedPct: 3.2, unpricedModelCount: 2, estimated: false },
};

describe('generateInsightNarrative', () => {
  it('accepts a reply that only restates numbers present in the facts', async () => {
    const reply =
      'Engineering drove the largest increase this period, up $1235 (about 25%). ' +
      'The top cost centre accounts for roughly 42% of spend, and 61% of spend sits with the top user tier. ' +
      'Projected month-end spend of $5000 is up from $4000 last period, with 3.2% of spend unallocated across 2 unpriced models.';

    const result = await generateInsightNarrative(facts, { callModel: async () => reply });

    expect(result.text).not.toBeNull();
    expect(result.text).toBe(reply.trim());
  });

  it('rejects a reply containing an invented number not derivable from the facts', async () => {
    const reply = 'Engineering spend jumped to an eye-watering $999 this period, way beyond forecast.';

    const result = await generateInsightNarrative(facts, { callModel: async () => reply });

    expect(result.text).toBeNull();
  });

  it('accepts a reply that restates exact 2-decimal fact values verbatim', async () => {
    const reply =
      'Engineering drove the largest increase this period, up $1234.56 (about 25.3%). ' +
      'The top cost centre accounts for roughly 42.1% of spend, and 61% of spend sits with the top user tier. ' +
      'Projected month-end spend of $5000 is up from $4000 last period, with 3.2% of spend unallocated across 2 unpriced models.';

    const result = await generateInsightNarrative(facts, { callModel: async () => reply });

    expect(result.text).not.toBeNull();
    expect(result.text).toBe(reply.trim());
  });

  it('never throws — a callModel rejection resolves to a null narrative', async () => {
    const result = await generateInsightNarrative(facts, {
      callModel: async () => {
        throw new Error('model unavailable');
      },
    });

    expect(result).toEqual({ text: null });
  });
});
