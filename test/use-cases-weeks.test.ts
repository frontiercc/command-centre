// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';

let cleanup: () => Promise<void>;

let weekStart: (ts: number) => number;
let createUseCase: (input: { title: string }) => Promise<{ id: string }>;
let ensureWeekRow: (useCaseId: string, weekStartS: number) => Promise<void>;
let recordWeekMatches: (
  useCaseId: string,
  weekStartS: number,
  matches: Array<{ userId: string | null; sessionId: string | null; occurredAt: number; isMessage: boolean; tier?: number | null }>,
) => Promise<void>;
let getMeasuredCompletedWeeks: (useCaseId: string, n: number, nowS: number) => Promise<Array<{ weekStart: number }>>;
let getCurrentWeek: (useCaseId: string, nowS: number) => Promise<{
  weekStart: number; distinctUsers: number; sessionCount: number; matchedMessages: number; latestTier: number | null; lastSeenAt: number | null;
} | null>;
let getWindowDistinctUsers: (useCaseId: string, weekStartsS: number[]) => Promise<number>;

const NOW = 1751500800; // Thu 2026-07-02 UTC-ish; any fixed epoch

beforeAll(async () => {
  const testDb = await createTestDatabase();
  cleanup = testDb.cleanup;

  const period = await import('@/lib/pulse/period');
  weekStart = period.weekStart;

  const queries = await import('@/lib/usecases/queries');
  createUseCase = queries.createUseCase;

  const weeks = await import('@/lib/usecases/weeks');
  ensureWeekRow = weeks.ensureWeekRow;
  recordWeekMatches = weeks.recordWeekMatches;
  getMeasuredCompletedWeeks = weeks.getMeasuredCompletedWeeks;
  getCurrentWeek = weeks.getCurrentWeek;
  getWindowDistinctUsers = weeks.getWindowDistinctUsers;
});

afterAll(async () => cleanup());

describe('use-case weekly rollup + junction', () => {
  const WK = () => weekStart(NOW);
  const PREV = () => WK() - 7 * 86400;

  it('ensureWeekRow writes a zero row (the measured marker)', async () => {
    const uc = await createUseCase({ title: 'wk zero' });
    await ensureWeekRow(uc.id, WK());
    const cur = await getCurrentWeek(uc.id, NOW);
    expect(cur).toEqual({ weekStart: WK(), distinctUsers: 0, sessionCount: 0, matchedMessages: 0, latestTier: null, lastSeenAt: null });
  });

  it('recordWeekMatches dedupes users/sessions exactly and counts messages per call', async () => {
    const uc = await createUseCase({ title: 'wk rec' });
    await recordWeekMatches(uc.id, WK(), [
      { userId: 'u1', sessionId: 's1', occurredAt: NOW - 10, isMessage: true },
      { userId: 'u1', sessionId: 's1', occurredAt: NOW - 9, isMessage: true },  // same pair, still 2 messages
      { userId: 'u2', sessionId: 's2', occurredAt: NOW - 8, isMessage: false, tier: 2 },
      { userId: null, sessionId: null, occurredAt: NOW - 7, isMessage: true }, // null user: message only
    ]);
    const cur = (await getCurrentWeek(uc.id, NOW))!;
    expect(cur.distinctUsers).toBe(2);
    expect(cur.sessionCount).toBe(2);
    expect(cur.matchedMessages).toBe(3);
    expect(cur.latestTier).toBe(2);
    expect(cur.lastSeenAt).toBe(NOW - 7);
    // idempotent junction: re-recording the same pair adds messages but not users
    await recordWeekMatches(uc.id, WK(), [{ userId: 'u1', sessionId: 's1', occurredAt: NOW - 5, isMessage: true }]);
    expect((await getCurrentWeek(uc.id, NOW))!.distinctUsers).toBe(2);
    expect((await getCurrentWeek(uc.id, NOW))!.matchedMessages).toBe(4);
  });

  it('completed weeks exclude the current week and absent weeks', async () => {
    const uc = await createUseCase({ title: 'wk hist' });
    await ensureWeekRow(uc.id, PREV());
    await ensureWeekRow(uc.id, WK());
    const completed = await getMeasuredCompletedWeeks(uc.id, 4, NOW);
    expect(completed.map(w => w.weekStart)).toEqual([PREV()]); // current week excluded, unmeasured older weeks absent
  });

  it('getWindowDistinctUsers unions users across weeks exactly', async () => {
    const uc = await createUseCase({ title: 'wk union' });
    await recordWeekMatches(uc.id, PREV(), [{ userId: 'u1', sessionId: 'a', occurredAt: PREV() + 60, isMessage: true }]);
    await recordWeekMatches(uc.id, WK(), [
      { userId: 'u1', sessionId: 'b', occurredAt: NOW, isMessage: true },
      { userId: 'u2', sessionId: 'c', occurredAt: NOW, isMessage: true },
    ]);
    expect(await getWindowDistinctUsers(uc.id, [PREV(), WK()])).toBe(2); // u1 counted once
  });
});
