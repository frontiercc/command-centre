// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { orsLevel, readOrs, orsRadarComment } from '@/lib/pulse/metrics/ors-status';

describe('orsLevel', () => {
  it('returns not-measurable for null', () => {
    expect(orsLevel(null)).toBe('not-measurable');
  });

  it('returns resilient at and above 0.7', () => {
    expect(orsLevel(0.7)).toBe('resilient');
    expect(orsLevel(0.95)).toBe('resilient');
  });

  it('returns developing between 0.5 and 0.7', () => {
    expect(orsLevel(0.5)).toBe('developing');
    expect(orsLevel(0.69)).toBe('developing');
  });

  it('returns early between 0.35 and 0.5 (the softened band)', () => {
    expect(orsLevel(0.35)).toBe('early');
    expect(orsLevel(0.4813)).toBe('early'); // real org-wide average that prompted this fix
    expect(orsLevel(0.49)).toBe('early');
  });

  it('returns concentrated below 0.35', () => {
    expect(orsLevel(0.34)).toBe('concentrated');
    expect(orsLevel(0)).toBe('concentrated');
  });
});

describe('readOrs', () => {
  it('never returns the alarming "Concentrated" label for a borderline org average like 0.48', () => {
    const read = readOrs(0.4813);
    expect(read.status).not.toContain('Concentrated');
    expect(read.level).toBe('early');
  });

  it('still reserves "Concentrated: structural warning" for genuinely low scores', () => {
    const read = readOrs(0.1);
    expect(read.status).toBe('Concentrated: structural warning');
    expect(read.level).toBe('concentrated');
  });

  it('does not claim capability sits with "one or two people" (can be low even with broad participation)', () => {
    const read = readOrs(0.1);
    expect(read.plain).not.toMatch(/one or two people/i);
  });

  it('handles the resilient and developing bands unchanged', () => {
    expect(readOrs(0.8).status).toBe('Resilient');
    expect(readOrs(0.6).status).toBe('Developing resilience');
  });

  it('handles null as not-yet-measurable', () => {
    expect(readOrs(null).status).toBe('Not yet measurable');
  });
});

describe('orsRadarComment', () => {
  it('mirrors the same bands as a short string', () => {
    expect(orsRadarComment(0.4813)).not.toMatch(/structural warning/i);
    expect(orsRadarComment(0.1)).toMatch(/structural warning/i);
    expect(orsRadarComment(null)).toBe('Needs 2+ active members');
  });
});
