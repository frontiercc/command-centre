// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { withTierNames } from '@/lib/pulse/tier-names';

describe('withTierNames', () => {
  it('shows the shipped tier name where stored text names a tier by number', () => {
    expect(withTierNames('Tier 3 session flagged as a potential new capability.', null))
      .toBe('Frontier session flagged as a potential new capability.');
  });

  it('follows a renamed tier', () => {
    expect(withTierNames('Tier 2 Engineering session flagged.', { t1: 'Admin', t2: 'Substantive', t3: 'Breakthrough' }))
      .toBe('Substantive Engineering session flagged.');
  });

  it('leaves other text alone, including tier numbers outside 1 to 3', () => {
    expect(withTierNames('Prompt: "Tier 4 pricing, Tiers 1-3"', null)).toBe('Prompt: "Tier 4 pricing, Tiers 1-3"');
  });
});
