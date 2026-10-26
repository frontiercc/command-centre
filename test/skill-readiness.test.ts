// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { assessReadiness, thresholdsFromConfig, type SkillCorpusStats } from '@/lib/usecases/skill-readiness';

const T = thresholdsFromConfig({});
const base: SkillCorpusStats = { prompts: 19, distinctPrompts: 19, people: 3, sessions: 9, days: 9, followUps: 8, weeksSpanned: 10, unreadableSessions: 0, firstAt: 1, lastAt: 2 };

describe('thresholdsFromConfig', () => {
  it('uses the spec defaults when config is empty', () => {
    expect(T).toEqual({ minPeople: 3, minPrompts: 10, minDays: 3, minFollowUps: 3, soloMinDays: 6, soloMinWeeks: 4 });
  });
  it('parses strings and falls back on junk or < 1', () => {
    expect(thresholdsFromConfig({ skillDraftMinPeople: '5', skillDraftMinDays: '0', skillDraftMinPrompts: 'x' }))
      .toEqual({ ...T, minPeople: 5 });
  });
});

describe('assessReadiness — team mode', () => {
  it('is ready when all four bars clear', () => {
    expect(assessReadiness(base, T)).toEqual({ ready: true, mode: 'team', missing: [] });
  });
  it('names every missing bar with have/need', () => {
    const r = assessReadiness({ ...base, people: 2, followUps: 1 }, T);
    expect(r.ready).toBe(false);
    expect(r.mode).toBeNull();
    expect(r.missing).toEqual([
      { key: 'people', label: 'people', have: 2, need: 3 },
      { key: 'followUps', label: 'follow-ups', have: 1, need: 3 },
    ]);
  });
  it('two people never qualifies, even with everything else', () => {
    const r = assessReadiness({ ...base, people: 2, days: 20, weeksSpanned: 12 }, T);
    expect(r.ready).toBe(false);
    expect(r.missing.map(m => m.key)).toEqual(['people']);
  });
});

describe('assessReadiness — solo mode', () => {
  it('one person on six days over four weeks with enough prompts and follow-ups is ready', () => {
    expect(assessReadiness({ ...base, people: 1, days: 6, weeksSpanned: 4 }, T)).toEqual({ ready: true, mode: 'solo', missing: [] });
  });
  it('one person short on weeks reports the solo gaps', () => {
    const r = assessReadiness({ ...base, people: 1, days: 6, weeksSpanned: 2 }, T);
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual([{ key: 'weeks', label: 'weeks spanned', have: 2, need: 4 }]);
  });
  it('zero people is not ready and reports people', () => {
    const r = assessReadiness({ ...base, people: 0, prompts: 0, distinctPrompts: 0, days: 0, followUps: 0, weeksSpanned: 0 }, T);
    expect(r.ready).toBe(false);
    expect(r.missing[0]).toEqual({ key: 'people', label: 'people', have: 0, need: 3 });
  });
});
