// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Spend Review's colleagues for a person are the kind of work's totals with
// that person taken out (peersExcluding). They must equal adding up everyone
// else, which is what the review did before, person by person.
import { describe, it, expect } from 'vitest';
import { peersExcluding, median, newTally, tallySession, type UserKindShare } from '@/lib/finance/spend-review';

/** The previous calculation: everyone but userId, added up. */
function addUpEveryoneElse(pop: Map<string, UserKindShare>, userId: string) {
  const users = new Set<string>();
  let sessionCount = 0;
  const sessionSpends: number[] = [];
  const toolUsers = new Map<string, Set<string>>();
  const toolSessions = new Map<string, number>();
  const byModel = new Map<string, { people: Set<string>; sessions: number; spends: number[]; measured: number; produced: number; tiered: number; deep: number }>();
  const usage = new Map<string, number>();
  for (const [uid, u] of pop) {
    if (uid === userId) continue;
    users.add(uid);
    sessionCount += u.sessions;
    sessionSpends.push(...u.sessionSpends);
    for (const [k, n] of u.toolSessions) {
      toolSessions.set(k, (toolSessions.get(k) ?? 0) + n);
      const s = toolUsers.get(k) ?? new Set<string>();
      s.add(uid);
      toolUsers.set(k, s);
    }
    for (const [m, t] of u.byModel) {
      const e = byModel.get(m) ?? { people: new Set(), sessions: 0, spends: [], measured: 0, produced: 0, tiered: 0, deep: 0 };
      for (const p of t.people) e.people.add(p);
      e.sessions += t.sessions; e.spends.push(...t.spends);
      e.measured += t.measured; e.produced += t.produced; e.tiered += t.tiered; e.deep += t.deep;
      byModel.set(m, e);
    }
    for (const [m, us] of u.usageByModel) usage.set(m, (usage.get(m) ?? 0) + us.inputTokens + us.outputTokens + us.cacheCreationTokens + us.cacheReadTokens);
  }
  return { users, sessionCount, sessionSpends, toolUsers, toolSessions, byModel, usage };
}

/** A small deterministic random generator, so a failure can be replayed. */
function rng(seed: number) {
  let x = seed;
  return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
}

function population(seed: number, people: number): Map<string, UserKindShare> {
  const r = rng(seed);
  const models = ['opus', 'sonnet', 'haiku'];
  const tools = ['skill:a', 'skill:b', 'connector:c', 'connector:d'];
  const pop = new Map<string, UserKindShare>();
  for (let i = 0; i < people; i++) {
    const uid = `u${i}`;
    const share: UserKindShare = { sessions: 0, sessionSpends: [], spendByModel: new Map(), toolSessions: new Map(), byModel: new Map(), usageByModel: new Map() };
    const sessions = 1 + Math.floor(r() * 4);
    for (let s = 0; s < sessions; s++) {
      const m = models[Math.floor(r() * models.length)];
      // Repeated spends on purpose: removal must take out one occurrence only.
      const spend = r() < 0.3 ? 1.5 : Math.round(r() * 1000) / 100;
      share.sessions += 1;
      share.sessionSpends.push(spend);
      share.spendByModel.set(m, (share.spendByModel.get(m) ?? 0) + spend);
      const t = share.byModel.get(m) ?? newTally();
      tallySession(t, { userId: uid, spend, produced: r() < 0.5 ? null : r() < 0.5, tier: r() < 0.2 ? null : 1 + Math.floor(r() * 3) });
      share.byModel.set(m, t);
      const prev = share.usageByModel.get(m) ?? { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
      share.usageByModel.set(m, { ...prev, inputTokens: prev.inputTokens + Math.floor(r() * 1000), outputTokens: prev.outputTokens + Math.floor(r() * 500) });
      for (const k of tools) if (r() < 0.3) share.toolSessions.set(k, (share.toolSessions.get(k) ?? 0) + 1);
    }
    pop.set(uid, share);
  }
  return pop;
}

describe('Spend Review colleagues', () => {
  it('taking one person out of the totals equals adding up everyone else', () => {
    for (const [seed, size] of [[1, 1], [2, 2], [3, 5], [4, 30], [5, 200]] as const) {
      const pop = population(seed, size);
      for (const uid of [...pop.keys(), 'not-in-this-work']) {
        const got = peersExcluding(pop, uid);
        const want = addUpEveryoneElse(pop, uid);
        expect(got.users.size).toBe(want.users.size);
        expect(got.sessionCount).toBe(want.sessionCount);
        expect([...got.sessionSpends].sort((a, b) => a - b)).toEqual([...want.sessionSpends].sort((a, b) => a - b));
        expect(median(got.sessionSpends)).toBe(median(want.sessionSpends));
        expect(new Map([...got.toolUsers].map(([k, v]) => [k, v.size]))).toEqual(new Map([...want.toolUsers].map(([k, v]) => [k, v.size])));
        expect(got.toolSessions).toEqual(want.toolSessions);
        expect([...got.byModel.keys()].sort()).toEqual([...want.byModel.keys()].sort());
        for (const [m, w] of want.byModel) {
          const g = got.byModel.get(m)!;
          expect({ people: g.people.size, sessions: g.sessions, measured: g.measured, produced: g.produced, tiered: g.tiered, deep: g.deep })
            .toEqual({ people: w.people.size, sessions: w.sessions, measured: w.measured, produced: w.produced, tiered: w.tiered, deep: w.deep });
          expect(median(g.spends)).toBe(median(w.spends));
          expect(g.spends.length).toBe(w.spends.length);
        }
        expect(new Map([...got.usageByModel].map(([m, u]) => [m, u.inputTokens + u.outputTokens + u.cacheCreationTokens + u.cacheReadTokens]))).toEqual(want.usage);
      }
    }
  });
});
