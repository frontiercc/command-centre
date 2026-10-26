// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';
import { seedUserSql } from './helpers/seed';

let sql: TestSql;
let cleanup: () => Promise<void>;

let computeUserDds: typeof import('@/lib/pulse/metrics/dds').computeUserDds;
let computeDdsForUsers: typeof import('@/lib/pulse/metrics/dds').computeDdsForUsers;
let computeUserOti: typeof import('@/lib/pulse/metrics/oti').computeUserOti;
let computeOtiForUsers: typeof import('@/lib/pulse/metrics/oti').computeOtiForUsers;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 24 * 60 * 60;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const ddsMod = await import('@/lib/pulse/metrics/dds');
  computeUserDds = ddsMod.computeUserDds;
  computeDdsForUsers = ddsMod.computeDdsForUsers;

  const otiMod = await import('@/lib/pulse/metrics/oti');
  computeUserOti = otiMod.computeUserOti;
  computeOtiForUsers = otiMod.computeOtiForUsers;

  await seedUserSql(sql, 'user-a');
  await seedUserSql(sql, 'user-b');
  await seedUserSql(sql, 'user-c'); // no activity at all
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`DELETE FROM pulse_classifications; DELETE FROM cowork_messages;`);
});

let msgSeq = 0;

/** Seed a cowork_messages row + a classified pulse_classifications row at a given tier/time. */
async function seedClassifiedEvent(userId: string, tier: 1 | 2 | 3, occurredAt: number) {
  const msgId = `msg-${++msgSeq}`;
  await sql.run(
    `INSERT INTO cowork_messages
       (id, session_id, user_id, message_type, role, content_preview, occurred_at, ingested_at)
     VALUES (?, 'sess-1', ?, 'cowork_user_message', 'user', 'do the thing', ?, ?)`,
    [msgId, userId, occurredAt, occurredAt],
  );

  await sql.run(
    `INSERT INTO pulse_classifications
       (cowork_message_id, user_id, tier, task_type, classifier_confidence,
        classifier_model, classifier_status, classified_at)
     VALUES (?, ?, ?, 'test_task', 0.9, 'test-model', 'classified', ?)`,
    [msgId, userId, tier, occurredAt],
  );
}

describe('computeDdsForUsers / computeOtiForUsers — equivalence with per-user functions', () => {
  it('matches computeUserDds and computeUserOti for 3 users with distinct histories, incl. one with no activity', async () => {
    // user-a: recent mixed tiers, baseline further back (14/7-day windows both hit)
    await seedClassifiedEvent('user-a', 1, NOW - 40 * DAY); // outside both DDS(14d) and OTI baseline(7d from earliest)
    await seedClassifiedEvent('user-a', 1, NOW - 3 * DAY);
    await seedClassifiedEvent('user-a', 2, NOW - 2 * DAY);
    await seedClassifiedEvent('user-a', 3, NOW - 1 * DAY);

    // user-b: different tier history & date spread — earliest much more recent, all Tier 3 currently
    await seedClassifiedEvent('user-b', 1, NOW - 6 * DAY); // within user-b's own baseline (earliest..earliest+7d)
    await seedClassifiedEvent('user-b', 3, NOW - 5 * DAY);
    await seedClassifiedEvent('user-b', 3, NOW - 1 * DAY);

    // user-c: no activity at all → both metrics null

    const ids = ['user-a', 'user-b', 'user-c'];

    const ddsMap = await computeDdsForUsers(ids);
    const otiMap = await computeOtiForUsers(ids);

    for (const id of ids) {
      const expectedDds = await computeUserDds(id);
      const expectedOti = await computeUserOti(id);

      const actualDds = ddsMap.get(id);
      const actualOti = otiMap.get(id);

      if (expectedDds === null) {
        expect(actualDds).toBeNull();
      } else {
        expect(actualDds).not.toBeNull();
        expect(actualDds as number).toBeCloseTo(expectedDds, 5);
      }

      // OTI v2 returns a structured OtiResult; the batch path uses the same
      // pure helper as the per-user path, so the whole result must match.
      if (expectedOti === null) {
        expect(actualOti).toBeNull();
      } else {
        expect(actualOti).not.toBeNull();
        expect(actualOti).toEqual(expectedOti);
      }
    }
  });

  it('returns an empty map for an empty user list', async () => {
    expect((await computeDdsForUsers([])).size).toBe(0);
    expect((await computeOtiForUsers([])).size).toBe(0);
  });

  it('returns null for every id when none have classified events', async () => {
    const ids = ['user-a', 'user-b', 'user-c'];
    const ddsMap = await computeDdsForUsers(ids);
    const otiMap = await computeOtiForUsers(ids);
    for (const id of ids) {
      expect(ddsMap.get(id)).toBeNull();
      expect(otiMap.get(id)).toBeNull();
    }
  });
});
