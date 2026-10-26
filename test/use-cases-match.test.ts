// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// A use case's recent activity (the detail page's live box), read from judged
// sessions, since use cases are defined by the work. The old
// OR-match of keywords, skills, connectors and task labels is gone.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
let activateUseCase: typeof import('@/lib/usecases/match').activateUseCase;
let createUseCase: typeof import('@/lib/usecases/queries').createUseCase;
let weekStart: typeof import('@/lib/pulse/period').weekStart;

const NOW = 1_790_000_000;
const DAY = 86400;

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
  ({ activateUseCase } = await import('@/lib/usecases/match'));
  ({ createUseCase } = await import('@/lib/usecases/queries'));
  ({ weekStart } = await import('@/lib/pulse/period'));
});
afterAll(async () => cleanup());
beforeEach(async () => {
  await sql.exec(`DELETE FROM use_case_session_judgements; DELETE FROM use_case_week_matches; DELETE FROM use_case_activation_weeks; DELETE FROM use_cases;`);
});

/** A judged session matched to the use case (by its work, or by its skill). */
async function judged(ucId: string, sessionId: string, userId: string, lastAt: number, prompts: number, by: 'work' | 'skill') {
  await sql.run(`INSERT INTO use_case_session_judgements (session_id, surface, user_id, use_case_ids, skill_matched_ids, candidate_key, prompt_count, first_event_at, last_event_at, judged_at)
    VALUES (?, 'cowork', ?, ?, ?, 'k', ?, ?, ?, ?)`,
    [sessionId, userId, by === 'work' ? JSON.stringify([ucId]) : '[]', by === 'skill' ? JSON.stringify([ucId]) : '[]', prompts, lastAt - 3600, lastAt, NOW]);
  await sql.run(`INSERT INTO use_case_activation_weeks (use_case_id, week_start, updated_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`, [ucId, weekStart(lastAt - 3600), NOW]);
  await sql.run(`INSERT INTO use_case_week_matches (use_case_id, week_start, user_id, session_id) VALUES (?, ?, ?, ?)`, [ucId, weekStart(lastAt - 3600), userId, sessionId]);
}

describe('activateUseCase (recent activity from judged sessions)', () => {
  it('counts the matched sessions in the window, their people and prompts, and says how they matched', async () => {
    const uc = await createUseCase({ title: 'Variance commentary', description: 'Finance work.', status: 'confirmed' });
    await judged(uc.id, 's1', 'anna', NOW - 2 * DAY, 3, 'work');
    await judged(uc.id, 's2', 'ben', NOW - 5 * DAY, 2, 'work');
    await judged(uc.id, 's3', 'anna', NOW - 1 * DAY, 0, 'skill');
    const e = await activateUseCase(uc, NOW);
    expect(e).toMatchObject({ seen: true, distinctUsers: 2, sessionCount: 3, matchedMessages: 5, lastSeenAt: NOW - DAY, windowDays: 30 });
    expect(e.signals).toEqual(['work', 'skill']);
  });

  it('leaves out sessions older than the window, and honours a custom window', async () => {
    const uc = await createUseCase({ title: 'Old work', status: 'confirmed' });
    await judged(uc.id, 'old', 'anna', NOW - 40 * DAY, 4, 'work');
    expect((await activateUseCase(uc, NOW)).seen).toBe(false);
    expect((await activateUseCase(uc, NOW, 60)).sessionCount).toBe(1);
  });

  it('a use case with no clues and no activity is simply not seen, never an error', async () => {
    const uc = await createUseCase({ title: 'Nothing yet', status: 'confirmed' });
    await expect(activateUseCase(uc, NOW)).resolves.toMatchObject({ seen: false, sessionCount: 0, matchedMessages: 0, latestTier: null, lastSeenAt: null, signals: [] });
  });

  it('counts weekly matches recorded without a judgement too (older weeks, seeded demo data), so the box agrees with the weekly table', async () => {
    const uc = await createUseCase({ title: 'Seeded', status: 'confirmed' });
    const wk = weekStart(NOW - 2 * DAY);
    await sql.run(`INSERT INTO use_case_activation_weeks (use_case_id, week_start, last_seen_at, updated_at) VALUES (?, ?, ?, ?)`, [uc.id, wk, NOW - 2 * DAY, NOW]);
    await sql.run(`INSERT INTO use_case_week_matches (use_case_id, week_start, user_id, session_id) VALUES (?, ?, 'anna', 'seeded-1'), (?, ?, 'ben', 'seeded-2')`, [uc.id, wk, uc.id, wk]);
    const e = await activateUseCase(uc, NOW);
    expect(e).toMatchObject({ seen: true, distinctUsers: 2, sessionCount: 2, matchedMessages: 0, lastSeenAt: NOW - 2 * DAY });
    expect(e.signals).toEqual([]);
  });

  it('does not count another use case\'s sessions', async () => {
    const a = await createUseCase({ title: 'A', status: 'confirmed' });
    const b = await createUseCase({ title: 'B', status: 'confirmed' });
    await judged(a.id, 'sa', 'anna', NOW - DAY, 1, 'work');
    expect((await activateUseCase(b, NOW)).seen).toBe(false);
  });
});
