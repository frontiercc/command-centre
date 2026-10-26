// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { validateTaxonomy } from '@/lib/pulse/taxonomy-validate';
import { DEFAULT_TIER_CONFIG } from '@/lib/pulse/tier-config';

const tax = (t1: string[], t2: string[] = ['analysis'], t3: string[] = []) => ({
  tier1: t1.map(name => ({ name, description: '' })), tier2: t2.map(name => ({ name, description: '' })), tier3: t3.map(name => ({ name, description: '' })),
});

describe('validateTaxonomy', () => {
  it('accepts the default taxonomy', () => {
    expect(validateTaxonomy(DEFAULT_TIER_CONFIG.taxonomy)).toBeNull();
  });
  it('refuses a row whose name was cleared (the 2026-09-26 localhost case)', () => {
    expect(validateTaxonomy(tax(['summarisation'], ['analysis', '', '']))).toMatch(/Tier 2 task type has no name/);
    expect(validateTaxonomy(tax(['summarisation'], ['analysis'], ['   ']))).toMatch(/Tier 3 task type has no name/);
  });
  it('refuses malformed and duplicate names', () => {
    expect(validateTaxonomy(tax(['Financial Commentary']))).toMatch(/not a valid task type name/);
    expect(validateTaxonomy(tax(['analysis'], ['analysis']))).toMatch(/more than once/);
  });
  it('refuses an empty taxonomy and a missing tier list', () => {
    expect(validateTaxonomy(tax([], []))).toMatch(/at least one/);
    expect(validateTaxonomy({ tier1: [], tier2: undefined, tier3: [] })).toMatch(/Tier 2 task type list is missing/);
  });
});
