// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// FinOps spend by product (lib/finance/product-split.ts): the parts always add
// up to the figure they split, an old snapshot's unexplained spend counts as
// undivided Claude, concentration tiers split into products that add up to
// the tier's share, and an OpenAI-only hub draws no Claude product.
import { describe, it, expect } from 'vitest';
import {
  partsOfRows, partsOfRow, partsTotal, vendorTotals, productsPresent, legendGroups, concentrationByProduct,
} from '@/lib/finance/product-split';
import { computeSpendConcentration } from '@/lib/pulse/code/concentration';

describe('partsOfRows', () => {
  it('splits rows into the four products, adding up to the total', () => {
    const parts = partsOfRows([
      { totalUsd: 3, codeUsd: 1, coworkUsd: 2 },
      { totalUsd: 5, codeUsd: 0, coworkUsd: 0, chatgptUsd: 4, codexUsd: 1 },
    ], 8);
    expect(parts).toEqual({ claude_code: 1, claude_cowork: 2, chatgpt: 4, codex: 1 });
    expect(partsTotal(parts)).toBeCloseTo(8, 9);
    expect(vendorTotals(parts)).toEqual({ claude: 3, openai: 5 });
  });

  it('counts spend the product fields leave unexplained as undivided Claude', () => {
    // A snapshot frozen before per-product fields: only totals.
    expect(partsOfRow({ totalUsd: 7 })).toEqual({ claude: 7 });
    // Rounding-sized remainders are not spend.
    expect(partsOfRow({ totalUsd: 1.001, codeUsd: 1 })).toEqual({ claude_code: 1 });
  });
});

describe('productsPresent and legendGroups', () => {
  it('lists only products with spend, Claude before OpenAI, grouped by vendor', () => {
    const present = productsPresent([{ codex: 1 }, { claude_code: 2 }, { claude_cowork: 0 }]);
    expect(present).toEqual(['claude_code', 'codex']);
    expect(legendGroups(present)).toEqual([
      { vendor: 'claude', label: 'Claude', products: ['claude_code'] },
      { vendor: 'openai', label: 'OpenAI', products: ['codex'] },
    ]);
  });

  it('leaves Claude out on an OpenAI-only hub', () => {
    expect(productsPresent([{ claude: 1, chatgpt: 2 }], { openaiOnly: true })).toEqual(['chatgpt']);
  });
});

describe('concentrationByProduct', () => {
  it('keeps the tiers of computeSpendConcentration and splits each into products adding up to its share', () => {
    const centres = [
      { totalUsd: 10, codeUsd: 6, coworkUsd: 0, chatgptUsd: 4, codexUsd: 0 },
      { totalUsd: 5, codeUsd: 0, coworkUsd: 5 },
      { totalUsd: 4, codeUsd: 0, coworkUsd: 0, chatgptUsd: 0, codexUsd: 4 },
      { totalUsd: 3, codeUsd: 3, coworkUsd: 0 },
      { totalUsd: 2, codeUsd: 1, coworkUsd: 1 },
      { totalUsd: 1 }, // an old centre with no product fields
      { totalUsd: 0, codeUsd: 0, coworkUsd: 0 },
    ];
    const tiers = concentrationByProduct(centres)!;
    const base = computeSpendConcentration(centres.map(c => c.totalUsd))!;
    expect(tiers.map(t => [t.topN, t.share])).toEqual(base.tiers.map(t => [t.topN, t.share]));
    for (const t of tiers) expect(partsTotal(t.parts)).toBeCloseTo(t.share, 9);
    // Top 1 is the $10 centre: $6 Claude Code and $4 ChatGPT of $25.
    expect(tiers[0].parts).toEqual({ claude_code: 6 / 25, chatgpt: 4 / 25 });
  });

  it('is null with too few centres, as the card has always been', () => {
    expect(concentrationByProduct([{ totalUsd: 1, codeUsd: 1 }])).toBeNull();
  });
});
