// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres coverage for the Users group of
// lib/db/queries.ts: getUsers, getDeactivatedUsers, deactivateUser,
// reactivateUser, getUserById, getUserCount, getActiveUsersThisWeek, getActiveUsersLastWeek.
//
// getActiveUsersThisWeek is the interesting one — a UNION of two per-surface
// subqueries wrapped in COUNT(DISTINCT ...). No date-bucket
// SQL was needed (the app computes weekAgo/twoWeeksAgo in JS and passes them
// as params), but the derived table in the UNION needs an alias — Postgres
// rejects one without ("subquery in FROM must have an alias").
//
// Runs against Postgres (testcontainers postgres:16, or the shared server
// named by CCC_TEST_PG_URL); skipped (not failed) without Docker.
//
// HARNESS RULE (copied from cowork-analytics-pg.test.ts): queries.ts reaches
// the database through getClient(), which binds to DATABASE_URL on first
// use, so the module-under-test (and schema) are DYNAMIC-imported
// AFTER createTestDbClient() has set DATABASE_URL + reset modules.
import { describe, it, expect } from 'vitest';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');
  try {
    // Dynamic import AFTER the DATABASE_URL env + module reset (harness rule).
    const { schema } = await import('@/lib/db/schema');
    const queries = await import('@/lib/db/queries');
    const {
      getUsers, getDeactivatedUsers, deactivateUser, reactivateUser, getUserById,
      getUserCount,
      getActiveUsersThisWeek, getActiveUsersLastWeek,
    } = queries;

    // ── Seed users ──────────────────────────────────────────────────────
    // user-1: last_seen_at = NOW            -> counts for "this week" (last_seen)
    // user-2: last_seen_at = NOW - 20d       -> counts for "this week" ONLY via
    //                                           a recent cowork_messages row
    // user-3: last_seen_at = NOW - 10d       -> lands in the [14d,7d) "last week"
    //                                           bucket only
    // user-4: last_seen_at = NOW - 1d, deactivated -> counts for "this week"
    //                                           (deactivation is irrelevant to
    //                                           the activity query) but is
    //                                           excluded from getUsers() default
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).insert(schema.users).values([
      { id: 'user-1', email: 'u1@test.local', last_seen_at: NOW },
      { id: 'user-2', email: 'u2@test.local', last_seen_at: NOW - 20 * DAY },
      { id: 'user-3', email: 'u3@test.local', last_seen_at: NOW - 10 * DAY },
      {
        id: 'user-4', email: 'u4@test.local', last_seen_at: NOW - 1 * DAY,
        deactivated_at: NOW - 1 * DAY, deactivation_reason: 'seed',
      },
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).insert(schema.coworkMessages).values([
      {
        id: 'msg-1', session_id: 'sess-1', user_id: 'user-2', message_type: 'cowork_user_message',
        occurred_at: NOW - 3600,
      },
      // user-2 was ALSO active last week (both-weeks user): their
      // last_seen_at sits in this week, so the old last_seen_at-band-only
      // getActiveUsersLastWeek missed them entirely — the message row is what
      // must count them into last week (the +900% WoW bug).
      {
        id: 'msg-2', session_id: 'sess-2', user_id: 'user-2', message_type: 'cowork_user_message',
        occurred_at: NOW - 9 * DAY,
      },
    ]);

    // ── getUserById ─────────────────────────────────────────────────────
    const u1 = await getUserById('user-1');
    expect(u1?.email).toBe('u1@test.local');
    expect(u1?.last_seen_at).toBe(NOW);
    expect(typeof u1?.last_seen_at).toBe('number');
    expect(await getUserById('does-not-exist')).toBeUndefined();

    // ── getUserCount: Number()-coerced count, deactivated included ──────
    const count = await getUserCount();
    expect(count).toBe(4);
    expect(typeof count).toBe('number');

    // ── getUsers: excludes deactivated by default, includes with flag ───
    const activeUsers = await getUsers();
    expect(activeUsers.map((u) => u.id).sort()).toEqual(['user-1', 'user-2', 'user-3']);
    const allUsers = await getUsers(500, true);
    expect(allUsers.length).toBe(4);

    // ── getDeactivatedUsers ───────────────────────────────────────────────
    const deactivated = await getDeactivatedUsers();
    expect(deactivated.map((u) => u.id)).toEqual(['user-4']);

    // ── getActiveUsersThisWeek: UNION(last_seen_at, cowork_messages) ────
    // user-1 (last_seen), user-4 (last_seen), user-2 (via cowork) = 3.
    // user-3 (10 days ago, no recent cowork) is excluded.
    const activeThisWeek = await getActiveUsersThisWeek();
    expect(activeThisWeek).toBe(3);
    expect(typeof activeThisWeek).toBe('number');

    // ── getActiveUsersLastWeek: UNION(last_seen_at band, cowork_messages band) ──
    // user-3 (last_seen 10 days ago) + user-2 (message 9 days ago — active BOTH
    // weeks, so their last_seen_at is this week and only the message row can
    // count them). The pre-fix version returned 1 here: it read the
    // last_seen_at band alone, so "last week" was really "users who went
    // quiet", and the dashboard's WoW% exploded (+900% on a production deployment).
    const activeLastWeek = await getActiveUsersLastWeek();
    expect(activeLastWeek).toBe(2);

    // ── deactivateUser / reactivateUser round-trip (on user-3) ──────────
    await deactivateUser('user-3', 'integration-test');
    const deactivatedUser3 = await getUserById('user-3');
    expect(deactivatedUser3?.deactivated_at).not.toBeNull();
    expect(typeof deactivatedUser3?.deactivated_at).toBe('number');
    expect(deactivatedUser3?.deactivation_reason).toBe('integration-test');
    expect((await getDeactivatedUsers()).map((u) => u.id).sort()).toEqual(['user-3', 'user-4']);
    // total count is unaffected by deactivation status
    expect(await getUserCount()).toBe(4);

    await reactivateUser('user-3');
    const reactivatedUser3 = await getUserById('user-3');
    expect(reactivatedUser3?.deactivated_at).toBeNull();
    expect(reactivatedUser3?.deactivation_reason).toBeNull();
    expect((await getDeactivatedUsers()).map((u) => u.id)).toEqual(['user-4']);
  } finally {
    await cleanup();
  }
}

describe('users (postgres)', () => {
  it(
    'user listing and activity buckets behave correctly on postgres',
    async () => {
      await runSpec();
    },
    180_000,
  );
});
