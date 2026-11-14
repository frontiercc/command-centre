// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAI's built-in rates against its Enterprise rate card ("ChatGPT Rate Card (Enterprise
 * token-based pricing)", help.openai.com article 20001415, read 2026-11-14): input, cached input
 * and output, USD per million tokens, Standard mode. A model the card lists that the table lacks
 * would show as unpriced and its spend would be left out, so every row is held here.
 */
import { describe, it, expect } from 'vitest';
import { OPENAI_DEFAULT_RATES, OPENAI_SPECIALIST_MODELS, OPENAI_CHAT_ONLY_MODELS } from '@/lib/pulse/code/rates';

// [model, input, cached input, output], as the card lists them.
const CARD: Array<[string, number, number, number]> = [
  ['gpt-6-pro', 10, 1, 50],
  ['gpt-6', 2, 0.2, 10],
  ['gpt-5.3', 1.75, 0.175, 14],
  ['gpt-6.1-sol', 2, 0.1, 10],
  ['gpt-6.1-terra', 1, 0.05, 5],
  ['gpt-6-astra', 10, 1, 50],
  ['gpt-6-astra-law', 10, 1, 50],
  ['gpt-6-sol', 2, 0.2, 10],
  ['gpt-6-luna', 0.1, 0.01, 0.5],
  ['gpt-5.6-sol', 4, 0.4, 20],
  ['gpt-5.6-terra', 2, 0.2, 12],
  ['gpt-5.6-luna', 0.2, 0.02, 1.2],
  ['gpt-6-rosalind-research', 15, 1.5, 75],
  ['gpt-5.5-rosalind-research', 5, 0.5, 25],
  ['gpt-5.5-rosalind-discovery', 5, 0.5, 25],
  ['gpt-5.5-cyber', 12.5, 1.25, 75],
  ['gpt-5.6-cyber', 12.5, 1.25, 75],
  ['gpt-6-cyber', 20, 2, 100],
  ['gpt-5.3-codex', 1.75, 0.175, 14],
  ['gpt-5.2', 1.75, 0.175, 14],
  ['o4-mini-deep-research', 2, 0.5, 8],
];

describe("OpenAI's rate card", () => {
  it.each(CARD)('prices %s at its card rates', (model, input, cached, output) => {
    const r = OPENAI_DEFAULT_RATES[model];
    expect(r).toBeDefined();
    expect(r.in).toBe(input);
    expect(r.cacheRead).toBe(cached);
    expect(r.out).toBe(output);
    // OpenAI charges no cache writes: they are billed as plain input.
    expect(r.cacheWrite).toBe(input);
  });

  it('has every model on the card and nothing that is not', () => {
    expect(Object.keys(OPENAI_DEFAULT_RATES).sort()).toEqual(CARD.map(([m]) => m).sort());
  });

  it('never suggests an approval-only model as a cheaper choice', () => {
    for (const m of ['gpt-6-astra-law', 'gpt-5.5-cyber', 'gpt-5.6-cyber', 'gpt-6-cyber', 'gpt-6-rosalind-research']) {
      expect(OPENAI_SPECIALIST_MODELS.has(m)).toBe(true);
    }
    // The Chat-only models are the card's Chat table alone.
    expect([...OPENAI_CHAT_ONLY_MODELS].sort()).toEqual(['gpt-5.3', 'gpt-6', 'gpt-6-pro']);
  });
});
