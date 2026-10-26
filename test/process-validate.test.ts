// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { validateProcessCandidates, rhythmLabel, computeProcessKey, tierNoteFor, DEFAULT_PROCESS_DENYLIST } from '@/lib/usecases/process-validate';

const day = 86400;
const ex = (index: number, userId: string, sessionId: string, dayN: number, text = 'draft the month-end variance commentary for the board pack') =>
  ({ index, text, userId, sessionId, occurredAt: 1735689600 + dayN * day }); // 2025-01-01 base
const BAR = { minUsers: 2 };
const good = { title: 'Month-end variance commentary', story: 'People assemble commentary from pasted rows.', valueHypothesis: 'Review instead of assembly.', keywords: ['variance commentary'], excerptIndices: [0, 1, 2] };
const EX3 = [ex(0, 'u1', 's1', 1), ex(1, 'u2', 's2', 8), ex(2, 'u1', 's3', 30)];

describe('validateProcessCandidates', () => {
  it('accepts a grounded multi-person candidate', () => {
    const out = validateProcessCandidates([good], EX3, DEFAULT_PROCESS_DENYLIST, BAR);
    expect(out).toHaveLength(1);
    expect(out[0].citedUsers.sort()).toEqual(['u1', 'u2']);
    expect(out[0].citedDays).toBe(3);
  });
  it('drops digit-bearing title/story/valueHypothesis (never repairs)', () => {
    for (const field of ['title', 'story', 'valueHypothesis'] as const) {
      expect(validateProcessCandidates([{ ...good, [field]: 'saves 35000 hours' }], EX3, DEFAULT_PROCESS_DENYLIST, BAR)).toHaveLength(0);
    }
  });
  it('drops citations that do not exist', () =>
    expect(validateProcessCandidates([{ ...good, excerptIndices: [0, 99] }], EX3, DEFAULT_PROCESS_DENYLIST, BAR)).toHaveLength(0));
  it('drops tool-shaped titles via denylist (case-insensitive)', () =>
    expect(validateProcessCandidates([{ ...good, title: 'Spreadsheet Analysis' }], EX3, DEFAULT_PROCESS_DENYLIST, BAR)).toHaveLength(0));
  it('recurrence: single day never qualifies', () => {
    const sameDay = [ex(0, 'u1', 's1', 1), ex(1, 'u2', 's2', 1)];
    expect(validateProcessCandidates([{ ...good, excerptIndices: [0, 1] }], sameDay, DEFAULT_PROCESS_DENYLIST, BAR)).toHaveLength(0);
  });
  it('one person is never a department suggestion, however many weeks they repeat it', () => {
    const solo = [0, 1, 2, 3, 4, 5].map(i => ex(i, 'u1', `s${i}`, i * 7 + 1));
    const why: string[] = [];
    expect(validateProcessCandidates([{ ...good, excerptIndices: [0, 1, 2, 3, 4, 5] }], solo, DEFAULT_PROCESS_DENYLIST, BAR, (_t, r) => why.push(r))).toHaveLength(0);
    expect(why).toEqual(['too few people cited (1 of 2)']);
  });
  it('a cross-department suggestion needs cited prompts from two departments, and records them', () => {
    const exd = (i: number, u: string, d: number, dept: string) => ({ ...ex(i, u, `s${i}`, d), department: dept });
    const twoDepts = [exd(0, 'u1', 1, 'Finance'), exd(1, 'u2', 8, 'Sales'), exd(2, 'u3', 15, 'Sales')];
    const oneDept = [exd(0, 'u1', 1, 'Sales'), exd(1, 'u2', 8, 'Sales'), exd(2, 'u3', 15, 'Sales')];
    const bar = { minUsers: 2, minDepartments: 2 };
    const out = validateProcessCandidates([good], twoDepts, DEFAULT_PROCESS_DENYLIST, bar);
    expect(out).toHaveLength(1);
    expect(out[0].citedDepartments).toEqual(['Finance', 'Sales']);
    const why: string[] = [];
    expect(validateProcessCandidates([good], oneDept, DEFAULT_PROCESS_DENYLIST, bar, (_t, r) => why.push(r))).toHaveLength(0);
    expect(why).toEqual(['seen in too few departments (1 of 2)']);
  });
  it('says why each left-out proposal was left out', () => {
    const why: string[] = [];
    validateProcessCandidates([
      { ...good, title: 'Saves 35000 hours' },
      { ...good, title: 'Spreadsheet analysis' },
      { ...good, title: 'Invented', excerptIndices: [99] },
      { ...good, title: 'One day', excerptIndices: [0] },
      good,
    ], EX3, DEFAULT_PROCESS_DENYLIST, BAR, (t, r) => why.push(`${t}: ${r}`));
    expect(why).toEqual([
      'Saves 35000 hours: contains a number',
      'Spreadsheet analysis: title is a tool or activity',
      'Invented: cited an excerpt that does not exist',
      'One day: seen on one day only',
    ]);
  });
  it('keeps only keywords that appear in a cited excerpt, and keeps the process when none survive (keywords are clues, spec 2026-10-05)', () => {
    const out = validateProcessCandidates([{ ...good, keywords: ['not present anywhere'] }], EX3, DEFAULT_PROCESS_DENYLIST, BAR);
    expect(out).toHaveLength(1);
    expect(out[0].keywords).toEqual([]);
  });
});

describe('rhythmLabel', () => {
  it('monthly when hits sit at month boundaries across >=2 months', () => {
    // 28-30 Jan and 26-28 Feb 2025 (UTC)
    const t = [Date.UTC(2025, 0, 29), Date.UTC(2025, 0, 30), Date.UTC(2025, 1, 26), Date.UTC(2025, 1, 27)].map(ms => ms / 1000);
    expect(rhythmLabel(t, 60).label).toBe('monthly');
  });
  it('weekly when hits land in >=3 distinct ISO weeks', () => {
    const t = [1, 8, 15, 22].map(d => Date.UTC(2025, 0, d) / 1000);
    expect(rhythmLabel(t, 28).label).toBe('weekly');
  });
  it('otherwise recurring with an honest display', () => {
    const r = rhythmLabel([Date.UTC(2025, 0, 3) / 1000, Date.UTC(2025, 0, 5) / 1000], 28);
    expect(r.label).toBe('recurring');
    expect(r.display).toBe('2 occasions over 4 weeks');
  });
});

describe('computeProcessKey', () => {
  it('is stable and case/whitespace-insensitive', () =>
    expect(computeProcessKey('Finance', ' Month-End ')).toBe(computeProcessKey('finance', 'month-end ')));
});

describe('tierNoteFor', () => {
  it('returns null for an empty list', () => {
    expect(tierNoteFor([])).toBeNull();
  });
  it('returns "Mostly tier N" for the mode of the list', () => {
    expect(tierNoteFor([1, 2, 2, 3])).toBe('Mostly tier 2');
  });
});

describe('computeProcessKey hex shape', () => {
  it('is a 32-char lowercase hex string', () => {
    const key = computeProcessKey('Finance', 'Month-End');
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('DEFAULT_PROCESS_DENYLIST', () => {
  it('rejects a denylisted title regardless of case/whitespace variation', () => {
    const out = validateProcessCandidates([{ ...good, title: '  REPORTING  ' }], EX3, DEFAULT_PROCESS_DENYLIST, BAR);
    expect(out).toHaveLength(0);
  });
});
