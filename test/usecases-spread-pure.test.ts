// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Spread's pure rule now that use cases are defined by the work: people doing the use case's
// work (judged sessions) who have not run its skill.
import { describe, it, expect } from 'vitest';
import {
  assembleSpread, buildCoachingPrompts, SPREAD_MIN_SESSIONS, SPREAD_PANEL_CAP, PROMPTS_PER_DEPT,
  type ActivityRow, type SpreadCandidate,
} from '@/lib/usecases/spread';
import { activityPhrase, evidenceLine } from '@/lib/usecases/spread-format';

const uc = { status: 'confirmed' as const, departments: ['Finance'] };
const row = (userId: string, sessions: number, dept: string | null = 'Finance'): ActivityRow => ({ userId, displayName: userId.toUpperCase(), dept, sessions });

describe('assembleSpread', () => {
  it('needs a confirmed use case with its own skill', () => {
    expect(assembleSpread({ ...uc, status: 'candidate' }, 'skill', [row('a', 5)], new Set(), new Map())).toBeNull();
    expect(assembleSpread(uc, null, [row('a', 5)], new Set(), new Map())).toEqual({ unsupported: 'no_skill' });
  });

  it('lists people doing the work regularly who have not run the skill', () => {
    const res = assembleSpread(uc, 'variance-commentary', [row('anna', 4), row('ben', SPREAD_MIN_SESSIONS - 1), row('cara', 3)], new Set(['cara']), new Map([['Finance', 1]]));
    if (!res || 'unsupported' in res) throw new Error('expected departments');
    expect(res.departments).toHaveLength(1);
    expect(res.departments[0].adopterCount).toBe(1);
    expect(res.departments[0].users.map(u => u.userId)).toEqual(['anna']);
    expect(res.departments[0].users[0]).toMatchObject({ matchedSignal: 'variance-commentary', matchedKind: 'work', activityCount: 4 });
  });

  it('keeps to the use case\'s departments, and caps the list', () => {
    const many = Array.from({ length: SPREAD_PANEL_CAP + 3 }, (_, i) => row(`p${i}`, 3));
    const res = assembleSpread(uc, 's', [...many, row('out', 9, 'Sales')], new Set(), new Map());
    if (!res || 'unsupported' in res) throw new Error('expected departments');
    expect(res.departments.map(d => d.dept)).toEqual(['Finance']);
    expect(res.departments[0].users).toHaveLength(SPREAD_PANEL_CAP);
    expect(res.departments[0].more).toBe(3);
  });

  it('a use case with no department applies to every department', () => {
    const res = assembleSpread({ status: 'confirmed', departments: [] }, 's', [row('a', 3, 'Sales'), row('b', 3, null)], new Set(), new Map());
    if (!res || 'unsupported' in res) throw new Error('expected departments');
    expect(res.departments.map(d => d.dept).sort()).toEqual(['No department', 'Sales']);
  });
});

describe('buildCoachingPrompts', () => {
  const cand = (userId: string, n: number): SpreadCandidate => ({ userId, displayName: userId, matchedSignal: 'variance-commentary', matchedKind: 'work', activityCount: n, signals: [{ signal: 'variance-commentary', kind: 'work', count: n }] });
  it('names the person, the work, the sessions and the skill', () => {
    const [p] = buildCoachingPrompts([{ useCase: { id: 'uc', title: 'Month-end variance commentary' }, candidates: [cand('Anna', 4)] }]);
    expect(p.promptText).toBe('Anna did "Month-end variance commentary" in 4 sessions in the last 4 weeks but hasn\'t used its skill, variance-commentary. Worth showing them.');
  });
  it('one prompt per person (their most-done use case), at most a few per department', () => {
    const out = buildCoachingPrompts([
      { useCase: { id: 'a', title: 'A' }, candidates: [cand('x', 2), cand('y', 5), cand('z', 3), cand('w', 4)] },
      { useCase: { id: 'b', title: 'B' }, candidates: [cand('x', 6)] },
    ]);
    expect(out).toHaveLength(PROMPTS_PER_DEPT);
    expect(out[0]).toMatchObject({ userId: 'x', useCaseId: 'b' });
  });
});

describe('spread wording', () => {
  it('counts sessions for judged work', () => {
    expect(activityPhrase(1, 'work')).toBe('1 session');
    expect(evidenceLine([{ signal: 's', kind: 'work', count: 3 }], 4)).toBe('did this work in 3 sessions in the last 4 weeks, without the skill');
  });
});
