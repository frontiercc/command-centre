// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';
import { seedUserSql } from './helpers/seed';

let sql: TestSql;
let cleanup: () => Promise<void>;

interface SurfaceStickiness { avgDau: number; mau: number; stickiness: number | null; }
let getProductStickiness: (nowEpochS?: number) => Promise<{
  cowork: SurfaceStickiness; code: SurfaceStickiness; chat: SurfaceStickiness;
}>;

const DAY = 86400;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const stickiness = await import('@/lib/pulse/stickiness');
  getProductStickiness = stickiness.getProductStickiness;

  await seedUserSql(sql, 'user-1');
  await seedUserSql(sql, 'user-2');
  await seedUserSql(sql, 'user-3');
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec('DELETE FROM cowork_messages');
  await sql.exec('DELETE FROM chat_messages');
});

async function insertCoworkMessage(opts: {
  id: string; userId: string | null; surface?: string | null; occurredAt: number;
}) {
  await sql.run(`
    INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [
    opts.id,
    `session-${opts.id}`,
    opts.userId,
    'cowork_user_message',
    opts.surface === undefined ? 'cowork' : opts.surface,
    opts.occurredAt,
  ]);
}

async function insertChatMessage(opts: { id: string; userId: string; occurredAt: number }) {
  await sql.run(`
    INSERT INTO chat_messages (id, user_id, prompt_text, prompt_length, occurred_at)
    VALUES (?, ?, ?, ?, ?)
  `, [opts.id, opts.userId, 'test prompt', 100, opts.occurredAt]);
}

describe('getProductStickiness', () => {
  it('returns null stickiness (not NaN) for a surface with no activity', async () => {
    const now = Math.floor(Date.now() / 1000);
    const result = await getProductStickiness(now);

    expect(result.cowork.mau).toBe(0);
    expect(result.cowork.avgDau).toBe(0);
    expect(result.cowork.stickiness).toBeNull();
    expect(result.code.stickiness).toBeNull();
    expect(result.chat.stickiness).toBeNull();
  });

  it('counts distinct users for mau, not events', async () => {
    const now = Math.floor(Date.now() / 1000);
    // user-1 posts 5 messages within the last 30 days
    for (let i = 0; i < 5; i++) {
      await insertCoworkMessage({ id: `m-${i}`, userId: 'user-1', occurredAt: now - 2 * DAY });
    }
    // user-2 posts once
    await insertCoworkMessage({ id: 'm-u2', userId: 'user-2', occurredAt: now - 3 * DAY });

    const result = await getProductStickiness(now);
    expect(result.cowork.mau).toBe(2);
  });

  it('avgDau excludes the current (partial) day', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Message "today" should not count toward avgDau (trailing 7 complete days = yesterday backwards)
    await insertCoworkMessage({ id: 'm-today', userId: 'user-1', occurredAt: now });
    // Message yesterday should count
    await insertCoworkMessage({ id: 'm-yesterday', userId: 'user-2', occurredAt: now - 1 * DAY });

    const result = await getProductStickiness(now);
    // mau counts both (30-day window includes today)
    expect(result.cowork.mau).toBe(2);
    // avgDau = 1 user-day over 7 days = 1/7
    expect(result.cowork.avgDau).toBeCloseTo(1 / 7, 5);
  });

  it('a user active on 2 surfaces (cowork + code) counts in both', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertCoworkMessage({ id: 'm-cowork', userId: 'user-1', surface: 'cowork', occurredAt: now - 2 * DAY });
    await insertCoworkMessage({ id: 'm-code', userId: 'user-1', surface: 'code', occurredAt: now - 2 * DAY });

    const result = await getProductStickiness(now);
    expect(result.cowork.mau).toBe(1);
    expect(result.code.mau).toBe(1);
  });

  it('treats NULL surface as cowork', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertCoworkMessage({ id: 'm-null-surface', userId: 'user-1', surface: null, occurredAt: now - 2 * DAY });

    const result = await getProductStickiness(now);
    expect(result.cowork.mau).toBe(1);
    expect(result.code.mau).toBe(0);
  });

  it('excludes cowork_messages rows with NULL user_id', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertCoworkMessage({ id: 'm-no-user', userId: null, occurredAt: now - 2 * DAY });

    const result = await getProductStickiness(now);
    expect(result.cowork.mau).toBe(0);
  });

  it('computes chat stickiness from chat_messages', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertChatMessage({ id: 'c-1', userId: 'user-1', occurredAt: now - 2 * DAY });
    await insertChatMessage({ id: 'c-2', userId: 'user-2', occurredAt: now - 2 * DAY });
    await insertChatMessage({ id: 'c-3', userId: 'user-1', occurredAt: now - 3 * DAY });

    const result = await getProductStickiness(now);
    expect(result.chat.mau).toBe(2);
    // 2 distinct-user-days: user-1 on day-2 & day-3, user-2 on day-2 => 3 user-days / 7
    expect(result.chat.avgDau).toBeCloseTo(3 / 7, 5);
  });

  it('rounds stickiness to 2dp and derives it as avgDau / mau', async () => {
    const now = Math.floor(Date.now() / 1000);
    // 3 distinct users active each of the last 7 days -> avgDau = 3, mau = 3
    for (let d = 1; d <= 7; d++) {
      await insertCoworkMessage({ id: `m-${d}-1`, userId: 'user-1', occurredAt: now - d * DAY });
      await insertCoworkMessage({ id: `m-${d}-2`, userId: 'user-2', occurredAt: now - d * DAY });
      await insertCoworkMessage({ id: `m-${d}-3`, userId: 'user-3', occurredAt: now - d * DAY });
    }

    const result = await getProductStickiness(now);
    expect(result.cowork.mau).toBe(3);
    expect(result.cowork.avgDau).toBe(3);
    expect(result.cowork.stickiness).toBe(1);
  });

  it('excludes users outside the 30-day mau window', async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertCoworkMessage({ id: 'm-old', userId: 'user-1', occurredAt: now - 31 * DAY });

    const result = await getProductStickiness(now);
    expect(result.cowork.mau).toBe(0);
  });
});
