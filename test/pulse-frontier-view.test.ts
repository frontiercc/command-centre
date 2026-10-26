// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The pure rules behind the Work Pulse frontier boxes:
// which label names a session, how best work is ranked, what a mainstay is.
import { describe, it, expect } from 'vitest';
import {
  summariseSession, groupSessions, rankBestWork, findMainstay, countRepeatsSince, emptyFacts, summariseInputs,
  type ClassRow, type SessionSummary, type SessionFacts,
} from '@/lib/pulse/frontier-view';

const row = (sessionId: string, taskType: string, tier: number, occurredAt: number, extra: Partial<ClassRow> = {}): ClassRow =>
  ({ userId: 'u1', sessionId, taskType, tier, capability: false, occurredAt, ...extra });
const sess = (sessionId: string, taskType: string, tier: number, occurredAt: number, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({ sessionId, userId: 'u1', taskType, tier, capability: false, occurredAt, ...extra });

describe('summariseSession', () => {
  it('takes the highest tier and the label used at that tier', () => {
    const s = summariseSession([row('s', 'drafting', 2, 1), row('s', 'analysis', 3, 2), row('s', 'drafting', 2, 3)]);
    expect(s).toMatchObject({ tier: 3, taskType: 'analysis', occurredAt: 3 });
  });

  it('prefers a work-shaped label over tool labels and capability_creation', () => {
    const s = summariseSession([
      row('s', 'connector_orchestration', 3, 1), row('s', 'connector_orchestration', 3, 2),
      row('s', 'capability_creation', 3, 3), row('s', 'synthesis', 3, 4),
    ]);
    expect(s.taskType).toBe('synthesis');
  });

  it('falls back to a lower-tier work label before a tool label', () => {
    expect(summariseSession([row('s', 'skill_invocation', 3, 1), row('s', 'analysis', 2, 2)]).taskType).toBe('analysis');
  });

  it('uses a tool label only when nothing else is there', () => {
    expect(summariseSession([row('s', 'connector_assisted', 2, 1)]).taskType).toBe('connector_assisted');
  });

  it('marks the session when any prompt was a capability candidate', () => {
    expect(summariseSession([row('s', 'analysis', 3, 1, { capability: true }), row('s', 'analysis', 2, 2)]).capability).toBe(true);
  });

  it('groupSessions splits rows by session', () => {
    expect(groupSessions([row('a', 'x', 1, 1), row('b', 'y', 2, 2), row('a', 'x', 3, 3)]).map(s => s.sessionId).sort()).toEqual(['a', 'b']);
  });
});

describe('rankBestWork', () => {
  const f = (steps: number | null, activeSecs: number | null): SessionFacts =>
    ({ ...emptyFacts(), steps, activeSecs });

  it('orders by tier, then capability, then steps, then active time', () => {
    const sessions = [
      sess('t2', 'a', 2, 10),
      sess('t3-few', 'a', 3, 10),
      sess('t3-cap', 'a', 3, 10, { capability: true }),
      sess('t3-many', 'a', 3, 10),
      sess('t3-many-long', 'a', 3, 10),
    ];
    const facts = new Map([
      ['t2', f(99, 9999)], ['t3-few', f(2, 100)], ['t3-cap', f(1, 1)],
      ['t3-many', f(30, 100)], ['t3-many-long', f(30, 900)],
    ]);
    expect(rankBestWork(sessions, facts).map(s => s.sessionId)).toEqual(['t3-cap', 't3-many-long', 't3-many', 't3-few', 't2']);
  });

  it('ranks a session with unmeasured facts below a measured one of the same tier', () => {
    const sessions = [sess('none', 'a', 3, 10), sess('some', 'a', 3, 5)];
    const facts = new Map([['some', f(3, 60)]]);
    expect(rankBestWork(sessions, facts)[0].sessionId).toBe('some');
  });
});

describe('findMainstay', () => {
  it('is null with no Tier 3 work in the window', () => {
    expect(findMainstay([sess('a', 'analysis', 2, 100), sess('b', 'analysis', 3, 5)], 50)).toBeNull();
  });

  it('picks the most frequent named kind of Tier 3 work, as a share of all Tier 3 sessions', () => {
    const m = findMainstay([
      sess('a', 'analysis', 3, 60), sess('b', 'analysis', 3, 80), sess('c', 'synthesis', 3, 90),
      sess('d', 'connector_orchestration', 3, 95), sess('e', 'analysis', 2, 99),
    ], 50);
    expect(m).toMatchObject({ count: 2, tier3Sessions: 4, session: { sessionId: 'b' } });
  });

  it('breaks a tie on the newest run', () => {
    const m = findMainstay([sess('a', 'analysis', 3, 60), sess('c', 'synthesis', 3, 90)], 50);
    expect(m?.session?.sessionId).toBe('c');
  });

  it('has no named kind when every Tier 3 session carries only tool labels', () => {
    expect(findMainstay([sess('a', 'skill_invocation', 3, 60), sess('b', 'capability_creation', 3, 70)], 50))
      .toEqual({ session: null, count: 0, tier3Sessions: 2 });
  });
});

describe('countRepeatsSince', () => {
  it('counts later sessions of the same kind at this tier or deeper', () => {
    const item = sess('x', 'analysis', 3, 10);
    const all = [item, sess('a', 'analysis', 3, 11), sess('b', 'analysis', 2, 12), sess('c', 'drafting', 3, 13), sess('d', 'analysis', 3, 5)];
    expect(countRepeatsSince(item, all)).toBe(1);
  });
});

describe('summariseInputs', () => {
  it('groups uploaded files by type, most common first', () => {
    expect(summariseInputs(['a.xlsx', 'b.csv', 'c.pdf', 'd.pptx', 'e.xlsx'])).toEqual(['3 spreadsheets', 'a PDF', 'a presentation']);
  });
  it('uses "an" where it reads right and counts unknown types as other files', () => {
    expect(summariseInputs(['x.png', 'y.zip', 'z.bin'])).toEqual(['2 other files', 'an image']);
    expect(summariseInputs(['y.zip'])).toEqual(['one other file']);
  });
});
