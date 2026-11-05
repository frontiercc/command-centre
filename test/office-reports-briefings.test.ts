// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Claude in Office in the reports and briefings: the FinOps and Spend Review
// report lines (an estimate, kept out of every total) and the briefings'
// "where the work happened" lines. Pure renderers, no database.
import { describe, it, expect } from 'vitest';
import { officeBlock } from '@/lib/reports/finops-sections';
import { officeSentence } from '@/lib/reports/spend-review-sections';
import { workByProductLines } from '@/lib/pulse/briefings/work-by-product';
import type { OfficeSpendSummary } from '@/lib/finance/office-spend';

const tok = (n: number) => ({ inputTokens: n, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });

const office: OfficeSpendSummary = {
  byProduct: [
    { product: 'excel', usd: 4.35, tokens: tok(1000), calls: 12, unpricedModels: [], people: 3 },
    { product: 'word', usd: null, tokens: tok(500), calls: 4, unpricedModels: ['claude-opus-5-5'], people: 1 },
    { product: 'powerpoint', usd: null, tokens: tok(0), calls: 0, unpricedModels: [], people: 0 },
  ],
  total: { usd: 4.35, tokens: tok(1500), calls: 16, unpricedModels: ['claude-opus-5-5'], people: 3 },
  hasOffice: true,
};

describe('FinOps report: Claude in Office block', () => {
  it('lists apps with activity as an estimate, names unpriced models, never $0', () => {
    const text = officeBlock(office);
    expect(text).toContain('### Claude in Office (estimate)');
    expect(text).toContain('not included in any total above');
    expect(text).toContain('| Excel | 3 | 12 | 1,000 | about $4.35 |');
    expect(text).toContain('| Word | 1 | 4 | 500 | not priced |');
    expect(text).not.toContain('| PowerPoint |');
    expect(text).toContain('claude-opus-5-5');
    expect(text).not.toContain('$0.00');
  });
  it('says nothing when there is no Office activity', () => {
    expect(officeBlock(null)).toBe('');
    expect(officeBlock({ ...office, hasOffice: false })).toBe('');
  });
});

describe('Spend Review report: Claude in Office line', () => {
  it('gives the estimate and the people, kept apart from the totals', () => {
    const line = officeSentence(office)!;
    expect(line).toContain('not included above');
    expect(line).toContain('about **$4.35** across 3 people');
    expect(line).toContain('Excel about $4.35, Word not priced');
  });
  it('is absent without Office activity', () => {
    expect(officeSentence(null)).toBeNull();
  });
});

describe('briefings: where the work happened', () => {
  it('lists every product used, with its count, when Office was used', () => {
    const lines = workByProductLines([
      { product: 'cowork', sessions: 120, people: 30 },
      { product: 'excel', sessions: 8, people: 1 },
    ]);
    expect(lines).toEqual([
      'Where the work happened, 2 products in total (measured sessions and people):',
      'Cowork: 120 sessions by 30 people',
      'Claude in Excel: 8 sessions by 1 person',
    ]);
  });
  it('adds nothing when only Cowork was used', () => {
    expect(workByProductLines([{ product: 'cowork', sessions: 120, people: 30 }])).toEqual([]);
  });
});
