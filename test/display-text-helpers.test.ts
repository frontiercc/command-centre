// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { STRIPPED_MARKER, REMOVED_TEXT, shownContent } from '@/lib/retention/marker';
import { STRIPPED_MARKER as CLEANUP_MARKER } from '@/lib/retention/cleanup';
import { capabilityTitle, cleanTitle } from '@/lib/pulse/capability-title';
import { topTierName } from '@/lib/pulse/tier-names';

describe('shownContent', () => {
  it('shows plain words where retention removed the text', () => {
    expect(shownContent(STRIPPED_MARKER)).toBe(REMOVED_TEXT);
    expect(REMOVED_TEXT).not.toMatch(/[—–]/);
  });

  it('leaves prompt text and empty values alone', () => {
    expect(shownContent('Draft the board pack — no template')).toBe('Draft the board pack — no template');
    expect(shownContent(null)).toBeNull();
  });

  it('is the same stored marker retention writes', () => {
    expect(CLEANUP_MARKER).toBe(STRIPPED_MARKER);
  });
});

describe('capability titles', () => {
  it('saves new titles without a dash', () => {
    expect(capabilityTitle('Engineering · Architecture')).toBe('New capability: Engineering · Architecture');
  });

  it('cleans every saved form to the kind of work', () => {
    expect(cleanTitle('New capability: Process Substitution')).toBe('Process Substitution');
    expect(cleanTitle('New capability — Process Substitution')).toBe('Process Substitution');
    expect(cleanTitle('Capability creation candidate (data_migration:planning)')).toBe('Data Migration · Planning');
  });
});

describe('topTierName', () => {
  const shipped = { t1: 'Administrative', t2: 'Meaningful', t3: 'Frontier' };
  it('gives one name when Work and Developer Pulse agree', () => {
    expect(topTierName(shipped, shipped)).toBe('Frontier');
    expect(topTierName(null, null)).toBe('Frontier');
  });

  it('uses the shorter name when one begins with the other, as the shipped names do', () => {
    expect(topTierName(shipped, { ...shipped, t3: 'Frontier delegation' })).toBe('Frontier');
  });

  it('gives both names when they have been renamed apart', () => {
    expect(topTierName(shipped, { ...shipped, t3: 'Architectural' })).toBe('Frontier or Architectural');
  });
});
