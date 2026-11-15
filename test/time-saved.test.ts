// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { computeTimeSaved, resolveTimeSavedAssumptions, TIME_SAVED_DEFAULTS } from '@/lib/pulse/code/time-saved';
import { createTestDatabase } from './helpers/db';

describe('TIME_SAVED_DEFAULTS', () => {
  it('has the agreed defaults, coding work only', async () => {
    expect(TIME_SAVED_DEFAULTS).toEqual({
      minPerPr: 150,
      minPerCommit: 20,
    });
  });
});

describe('computeTimeSaved', () => {
  it('computes hours per row and a rounded total', async () => {
    const counts = { prCount: 4, commitCount: 30 };
    const result = computeTimeSaved(counts, TIME_SAVED_DEFAULTS);

    const pr = result.rows.find(r => r.label === 'pull requests opened');
    expect(pr).toEqual({ label: 'pull requests opened', count: 4, minutesEach: 150, hours: 10 }); // 4*150/60 = 10h

    const commit = result.rows.find(r => r.label === 'AI-assisted commits');
    expect(commit!.hours).toBeCloseTo((30 * 20) / 60, 5); // 10h

    const expectedTotal = (4 * 150 + 30 * 20) / 60;
    expect(result.totalHours).toBe(Math.round(expectedTotal));
  });

  // The owner's rule, 2026-11-15: Developer Pulse's Time saved counts coding work only.
  // Claude Cowork and Claude Chat time saved belongs on Work Pulse.
  it('has coding rows only: no Cowork or Chat rows', async () => {
    const result = computeTimeSaved({ prCount: 1, commitCount: 1 }, TIME_SAVED_DEFAULTS);
    expect(result.rows.map(r => r.label)).toEqual(['pull requests opened', 'AI-assisted commits']);
  });

  it('omits rows for zero counts', async () => {
    const counts = { prCount: 4, commitCount: 0 };
    const result = computeTimeSaved(counts, TIME_SAVED_DEFAULTS);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].label).toBe('pull requests opened');
  });

  it('returns zero rows and zero total when all counts are zero', async () => {
    const counts = { prCount: 0, commitCount: 0 };
    const result = computeTimeSaved(counts, TIME_SAVED_DEFAULTS);
    expect(result.rows).toEqual([]);
    expect(result.totalHours).toBe(0);
  });

  it('honours custom assumptions', async () => {
    const counts = { prCount: 1, commitCount: 0 };
    const assumptions = { minPerPr: 60, minPerCommit: 20 };
    const result = computeTimeSaved(counts, assumptions);
    expect(result.rows[0]).toEqual({ label: 'pull requests opened', count: 1, minutesEach: 60, hours: 1 });
    expect(result.totalHours).toBe(1);
  });
});

describe('resolveTimeSavedAssumptions', () => {
  const blankConfig = {
    timeSavedMinPerPr: '',
    timeSavedMinPerCommit: '',
  };

  it('falls back to TIME_SAVED_DEFAULTS on blank config', async () => {
    expect(resolveTimeSavedAssumptions(blankConfig)).toEqual(TIME_SAVED_DEFAULTS);
  });

  it('falls back to TIME_SAVED_DEFAULTS on NaN config', async () => {
    const cfg = { ...blankConfig, timeSavedMinPerPr: 'not-a-number' };
    expect(resolveTimeSavedAssumptions(cfg)).toEqual(TIME_SAVED_DEFAULTS);
  });

  it('applies a config override for a single field, defaulting the rest', async () => {
    const cfg = { ...blankConfig, timeSavedMinPerPr: '90' };
    expect(resolveTimeSavedAssumptions(cfg)).toEqual({
      ...TIME_SAVED_DEFAULTS,
      minPerPr: 90,
    });
  });

  it('applies overrides for both fields', async () => {
    const cfg = {
      timeSavedMinPerPr: '60',
      timeSavedMinPerCommit: '15',
    };
    expect(resolveTimeSavedAssumptions(cfg)).toEqual({
      minPerPr: 60,
      minPerCommit: 15,
    });
  });
});

describe('Time Saved config plumbing', () => {
  let cleanup: () => Promise<void>;
  let cfg: typeof import('@/lib/config');
  beforeAll(async () => { const t = await createTestDatabase(); cleanup = t.cleanup; cfg = await import('@/lib/config'); });
  afterAll(async () => cleanup());

  it('defaults to blank (use TIME_SAVED_DEFAULTS)', async () => {
    const c = (await cfg.getAllConfig());
    expect(c.timeSavedMinPerPr).toBe('');
    expect(c.timeSavedMinPerCommit).toBe('');
    expect(c.timeSavedMinPerCoworkSession).toBe('');
    expect(c.timeSavedMinPerChatConversation).toBe('');
  });

  it('persists an override via setConfigValue', async () => {
    await cfg.setConfigValue('timeSavedMinPerPr', '90');
    expect(await cfg.getConfigValue('timeSavedMinPerPr')).toBe('90');
  });
});
