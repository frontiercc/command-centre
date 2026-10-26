// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';
import { seedUserSql } from './helpers/seed';
import { weekStarts } from '@/lib/pulse/period';

let sql: TestSql;
let cleanup: () => Promise<void>;

let buildSessionOutputRate: (nowS?: number) => Promise<{
  hasData: boolean;
  sessions: number;
  produced: number;
  rate: number | null;
  weeks: Array<{ weekStart: number; sessions: number; produced: number; rate: number | null }>;
  byTaskType: Array<{ taskType: string; sessions: number; produced: number; rate: number }>;
}>;
let OUTPUT_RATE_WEEKS: number;
let MIN_SESSIONS_FOR_RATE: number;

const WEEK = 7 * 24 * 60 * 60;

// A fixed Monday-anchored "now" so the window never races the real clock.
const NOW = 1_757_937_600; // 2026-09-15T12:00:00Z-ish, pinned

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const mod = await import('@/lib/pulse/cowork/session-output-rate');
  buildSessionOutputRate = mod.buildSessionOutputRate;
  OUTPUT_RATE_WEEKS = mod.OUTPUT_RATE_WEEKS;
  MIN_SESSIONS_FOR_RATE = mod.MIN_SESSIONS_FOR_RATE;

  await seedUserSql(sql, 'user-1');
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec('DELETE FROM pulse_classifications');
  await sql.exec('DELETE FROM cowork_messages');
  await sql.exec('DELETE FROM cowork_session_stats');
  await sql.exec('DELETE FROM cowork_sessions');
});

let seq = 0;
/**
 * `producedOutput` mirrors what the session aggregator writes: 1 when a
 * SUCCESSFUL output tool ran, 0 when none did, null for a session not yet
 * aggregated since the column was added (which must be excluded entirely).
 */
async function insertSession(startedAt: number, producedOutput: 0 | 1 | null) {
  const id = `sess-${++seq}`;
  await sql.run(
    'INSERT INTO cowork_sessions (id, conversation_id, user_id, started_at) VALUES (?, ?, ?, ?)',
    [id, `conv-${seq}`, 'user-1', startedAt],
  );
  await sql.run(
    `INSERT INTO cowork_session_stats (session_id, user_id, first_event_at, last_event_at, produced_output, computed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, 'user-1', startedAt, startedAt + 60, producedOutput, startedAt],
  );
  return id;
}

/**
 * Classify a session by writing the cowork_user_message row the classifier
 * tags plus its pulse_classifications row — the same shape the real pipeline
 * produces, so the shared session-collapse helper is genuinely exercised
 * rather than stubbed.
 */
async function classify(sessionId: string, taskType: string, occurredAt: number) {
  const msgId = `msg-${sessionId}-${taskType}-${occurredAt}`;
  await sql.run(
    `INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, occurred_at)
     VALUES (?, ?, ?, 'cowork_user_message', 'cowork', 'otel', ?)`,
    [msgId, sessionId, 'user-1', occurredAt],
  );
  await sql.run(
    `INSERT INTO pulse_classifications
       (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at)
     VALUES (?, ?, 2, ?, 0.9, 'test-model', ?)`,
    [msgId, 'user-1', taskType, occurredAt],
  );
}

/** Monday start of the most recent COMPLETED week in the window. */
function lastCompletedWeek(): number {
  const ws = weekStarts(NOW - WEEK, OUTPUT_RATE_WEEKS);
  return ws[ws.length - 1];
}

describe('buildSessionOutputRate', () => {
  it('reports hasData false and null rate when there are no sessions', async () => {
    const r = await buildSessionOutputRate(NOW);
    expect(r.hasData).toBe(false);
    expect(r.sessions).toBe(0);
    expect(r.rate).toBeNull();
  });

  it('always returns the full window of weeks, oldest first', async () => {
    const r = await buildSessionOutputRate(NOW);
    expect(r.weeks).toHaveLength(OUTPUT_RATE_WEEKS);
    for (let i = 1; i < r.weeks.length; i++) {
      expect(r.weeks[i].weekStart).toBe(r.weeks[i - 1].weekStart + WEEK);
    }
  });

  it('counts a session that produced something', async () => {
    await insertSession(lastCompletedWeek() + 3600, 1);
    const r = await buildSessionOutputRate(NOW);
    expect(r.sessions).toBe(1);
    expect(r.produced).toBe(1);
    // The HEADLINE has no floor — it is the whole window, not a slice.
    expect(r.rate).toBe(1);
  });

  it('does not count a session that produced nothing', async () => {
    await insertSession(lastCompletedWeek() + 3600, 0);
    const r = await buildSessionOutputRate(NOW);
    expect(r.sessions).toBe(1);
    expect(r.produced).toBe(0);
    expect(r.rate).toBe(0);
  });

  it('withholds a WEEK rate below the session floor but keeps its counts', async () => {
    const wk = lastCompletedWeek();
    await insertSession(wk + 3600, 1);
    const r = await buildSessionOutputRate(NOW);
    const week = r.weeks.find((w) => w.weekStart === wk)!;
    // One session that produced something is not "100%" — it is one session.
    expect(week.sessions).toBe(1);
    expect(week.produced).toBe(1);
    expect(week.rate).toBeNull();
  });

  it('reports a WEEK rate once it clears the floor', async () => {
    const wk = lastCompletedWeek();
    for (let i = 0; i < MIN_SESSIONS_FOR_RATE; i++) await insertSession(wk + 3600, i < 2 ? 1 : 0);
    const r = await buildSessionOutputRate(NOW);
    const week = r.weeks.find((w) => w.weekStart === wk)!;
    expect(week.sessions).toBe(MIN_SESSIONS_FOR_RATE);
    expect(week.rate).toBeCloseTo(2 / MIN_SESSIONS_FOR_RATE, 6);
  });

  it('computes the headline rate across mixed sessions', async () => {
    const wk = lastCompletedWeek() + 3600;
    await insertSession(wk, 1);
    await insertSession(wk, 1);
    await insertSession(wk, 0);
    await insertSession(wk, 0);
    const r = await buildSessionOutputRate(NOW);
    expect(r.sessions).toBe(4);
    expect(r.produced).toBe(2);
    expect(r.rate).toBe(0.5);
    // ...but the WEEK holding those 4 sessions is below the floor, so its own
    // rate is withheld even though the headline reports one.
    expect(r.weeks.find((w) => w.sessions === 4)!.rate).toBeNull();
  });

  it('buckets a session into the week it STARTED', async () => {
    const lastWk = lastCompletedWeek();
    const earlierWk = lastWk - WEEK;
    await insertSession(earlierWk + 60, 1);
    await insertSession(lastWk + 60, 0);

    const r = await buildSessionOutputRate(NOW);
    const earlier = r.weeks.find((w) => w.weekStart === earlierWk)!;
    const last = r.weeks.find((w) => w.weekStart === lastWk)!;
    expect(earlier.sessions).toBe(1);
    expect(earlier.produced).toBe(1);
    expect(last.sessions).toBe(1);
    expect(last.produced).toBe(0);
    // Both weeks hold a single session, so neither reports a rate.
    expect(earlier.rate).toBeNull();
    expect(last.rate).toBeNull();
  });

  it('gives an empty week rate null, never 0', async () => {
    await insertSession(lastCompletedWeek() + 3600, 1);
    const r = await buildSessionOutputRate(NOW);
    const empty = r.weeks.filter((w) => w.sessions === 0);
    expect(empty.length).toBeGreaterThan(0);
    for (const w of empty) expect(w.rate).toBeNull();
  });

  it('excludes sessions older than the window', async () => {
    const ws = weekStarts(NOW - WEEK, OUTPUT_RATE_WEEKS);
    await insertSession(ws[0] - WEEK, 1); // one week before the window opens
    const r = await buildSessionOutputRate(NOW);
    expect(r.sessions).toBe(0);
    expect(r.hasData).toBe(false);
  });

  it('excludes the partial current week', async () => {
    const currentWeek = lastCompletedWeek() + WEEK;
    await insertSession(currentWeek + 3600, 1);
    const r = await buildSessionOutputRate(NOW);
    expect(r.sessions).toBe(0);
  });

  it('EXCLUDES a not-yet-aggregated session rather than counting it as a miss', async () => {
    await insertSession(lastCompletedWeek() + 3600, null);
    const r = await buildSessionOutputRate(NOW);
    expect(r.sessions).toBe(0);
    expect(r.hasData).toBe(false);
    expect(r.rate).toBeNull();
  });

  it('does not let unaggregated sessions depress the rate', async () => {
    const wk = lastCompletedWeek() + 3600;
    await insertSession(wk, 1);
    await insertSession(wk, null);
    await insertSession(wk, null);
    const r = await buildSessionOutputRate(NOW);
    expect(r.sessions).toBe(1);
    expect(r.rate).toBe(1);
  });

  it('breaks the rate down by task type', async () => {
    const wk = lastCompletedWeek() + 3600;
    // 6 analysis sessions, 5 of which produced something.
    for (let i = 0; i < 6; i++) {
      const id = await insertSession(wk, i < 5 ? 1 : 0);
      await classify(id, 'analysis', wk);
    }
    // 6 summarisation sessions, 1 of which produced something.
    for (let i = 0; i < 6; i++) {
      const id = await insertSession(wk, i < 1 ? 1 : 0);
      await classify(id, 'summarisation', wk);
    }

    const r = await buildSessionOutputRate(NOW);
    expect(r.byTaskType).toHaveLength(2);
    // Rate descending — the weakest converter sorts last, where the gap is.
    expect(r.byTaskType[0]).toMatchObject({ taskType: 'analysis', sessions: 6, produced: 5 });
    expect(r.byTaskType[1]).toMatchObject({ taskType: 'summarisation', sessions: 6, produced: 1 });
    expect(r.byTaskType[0].rate).toBeGreaterThan(r.byTaskType[1].rate);
  });

  it('drops a task type below the session floor rather than showing 100% off one session', async () => {
    const wk = lastCompletedWeek() + 3600;
    const thin = await insertSession(wk, 1);
    await classify(thin, 'research_brief', wk);
    for (let i = 0; i < MIN_SESSIONS_FOR_RATE; i++) {
      const id = await insertSession(wk, 1);
      await classify(id, 'analysis', wk);
    }

    const r = await buildSessionOutputRate(NOW);
    expect(r.byTaskType.map((t) => t.taskType)).toEqual(['analysis']);
    // The thin session still counts toward the headline — dropped from the
    // breakdown, never from the total.
    expect(r.sessions).toBe(MIN_SESSIONS_FOR_RATE + 1);
  });

  it('gives an unlabelled session no row, while still counting it in the headline', async () => {
    const wk = lastCompletedWeek() + 3600;
    for (let i = 0; i < MIN_SESSIONS_FOR_RATE; i++) await insertSession(wk, i === 0 ? 1 : 0);
    const r = await buildSessionOutputRate(NOW);
    // No "Unclassified" row — the breakdown lists named kinds of work only.
    expect(r.byTaskType).toEqual([]);
    expect(r.sessions).toBe(MIN_SESSIONS_FOR_RATE);
    expect(r.produced).toBe(1);
  });

  it('gives a mechanism-labelled session no row either', async () => {
    const wk = lastCompletedWeek() + 3600;
    // Enough to clear the floor, so only the mechanism rule can exclude them.
    for (let i = 0; i < MIN_SESSIONS_FOR_RATE + 2; i++) {
      const id = await insertSession(wk, 1);
      await classify(id, 'connector_assisted', wk);
    }
    const r = await buildSessionOutputRate(NOW);
    expect(r.byTaskType).toEqual([]);
    expect(r.sessions).toBe(MIN_SESSIONS_FOR_RATE + 2);
  });

  it('still lists a work type when a session carries both it and a mechanism label', async () => {
    const wk = lastCompletedWeek() + 3600;
    for (let i = 0; i < MIN_SESSIONS_FOR_RATE; i++) {
      const id = await insertSession(wk, i < 3 ? 1 : 0);
      await classify(id, 'analysis', wk);
      // Mechanism label appears far more often, as it does in real telemetry.
      for (let j = 0; j < 8; j++) await classify(id, 'connector_assisted', wk + j + 1);
    }
    const r = await buildSessionOutputRate(NOW);
    expect(r.byTaskType.map((t) => t.taskType)).toEqual(['analysis']);
    expect(r.byTaskType[0].sessions).toBe(MIN_SESSIONS_FOR_RATE);
  });

  it('returns an empty breakdown when nothing clears the floor', async () => {
    await insertSession(lastCompletedWeek() + 3600, 1);
    const r = await buildSessionOutputRate(NOW);
    expect(r.byTaskType).toEqual([]);
    expect(r.rate).toBe(1);
  });
});
