// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { computeTimeSaved, resolveTimeSavedAssumptions, TIME_SAVED_DEFAULTS } from '@/lib/pulse/code/time-saved';
import { createTestDatabase } from './helpers/db';

describe('TIME_SAVED_DEFAULTS', () => {
  it('has the agreed defaults', async () => {
    expect(TIME_SAVED_DEFAULTS).toEqual({
      minPerPr: 150,
      minPerCommit: 20,
      minPerCoworkSession: 10,
      minPerChatConversation: 4,
    });
  });
});

describe('computeTimeSaved', () => {
  it('computes hours per row and a rounded total', async () => {
    const counts = { prCount: 4, commitCount: 30, coworkSessions: 12, chatConversations: 8 };
    const result = computeTimeSaved(counts, TIME_SAVED_DEFAULTS);

    const pr = result.rows.find(r => r.label === 'PRs');
    expect(pr).toEqual({ label: 'PRs', count: 4, minutesEach: 150, hours: 10 }); // 4*150/60 = 10h

    const commit = result.rows.find(r => r.label === 'AI-assisted commits');
    expect(commit!.hours).toBeCloseTo((30 * 20) / 60, 5); // 10h

    const cowork = result.rows.find(r => r.label === 'Cowork sessions');
    expect(cowork!.hours).toBeCloseTo((12 * 10) / 60, 5); // 2h

    const chat = result.rows.find(r => r.label === 'Chat conversations');
    expect(chat!.hours).toBeCloseTo((8 * 4) / 60, 5); // ~0.533h

    const expectedTotal = (4 * 150 + 30 * 20 + 12 * 10 + 8 * 4) / 60;
    expect(result.totalHours).toBe(Math.round(expectedTotal));
  });

  it('omits rows for zero counts', async () => {
    const counts = { prCount: 4, commitCount: 0, coworkSessions: 0, chatConversations: 0 };
    const result = computeTimeSaved(counts, TIME_SAVED_DEFAULTS);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].label).toBe('PRs');
  });

  it('returns zero rows and zero total when all counts are zero', async () => {
    const counts = { prCount: 0, commitCount: 0, coworkSessions: 0, chatConversations: 0 };
    const result = computeTimeSaved(counts, TIME_SAVED_DEFAULTS);
    expect(result.rows).toEqual([]);
    expect(result.totalHours).toBe(0);
  });

  it('honours custom assumptions', async () => {
    const counts = { prCount: 1, commitCount: 0, coworkSessions: 0, chatConversations: 0 };
    const assumptions = { minPerPr: 60, minPerCommit: 20, minPerCoworkSession: 10, minPerChatConversation: 4 };
    const result = computeTimeSaved(counts, assumptions);
    expect(result.rows[0]).toEqual({ label: 'PRs', count: 1, minutesEach: 60, hours: 1 });
    expect(result.totalHours).toBe(1);
  });
});

describe('resolveTimeSavedAssumptions', () => {
  const blankConfig = {
    timeSavedMinPerPr: '',
    timeSavedMinPerCommit: '',
    timeSavedMinPerCoworkSession: '',
    timeSavedMinPerChatConversation: '',
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

  it('applies overrides for all four fields', async () => {
    const cfg = {
      timeSavedMinPerPr: '60',
      timeSavedMinPerCommit: '15',
      timeSavedMinPerCoworkSession: '8',
      timeSavedMinPerChatConversation: '2',
    };
    expect(resolveTimeSavedAssumptions(cfg)).toEqual({
      minPerPr: 60,
      minPerCommit: 15,
      minPerCoworkSession: 8,
      minPerChatConversation: 2,
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
