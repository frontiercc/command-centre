// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres date-bucket TZ regression test.
//
// lib/db/queries.ts's Postgres date-bucket expression (getSnapshotsForUser's
// fallback synthesis, line ~389, and getAdoptionTrend's live fallback, line
// ~493) used `to_char(to_timestamp(col), 'YYYY-MM-DD')`, which formats in the
// POSTGRES SESSION timezone, where the bucket must be unconditionally UTC.
// It was only correct while the Postgres session TimeZone happened to be
// UTC — true of testcontainers' postgres:16 default, which silently masked
// the bug. A production Postgres (RDS) configured with
// a non-UTC TimeZone GUC would bucket differently near midnight UTC, with no
// error — silent analytics misbucketing (getSnapshotsForUser's fallback +
// every getAdoptionTrend live-fallback query).
//
// This test forces the Postgres session onto 'America/New_York' (permanently
// UTC-4/-5, so the mismatch reproduces year-round regardless of DST) BEFORE
// running the two affected queries, and asserts the returned date bucket for
// a timestamp deliberately placed at 02:00 UTC (which is *the previous
// calendar day* in America/New_York, any time of year) still comes back as
// the UTC calendar day.
//
// Fail-before/pass-after proof:
// reverting the `AT TIME ZONE 'UTC'` fix in lib/db/queries.ts makes this
// test fail — it returns the PREVIOUS day (America/New_York's calendar date
// for the boundary timestamp) instead of the correct UTC day.
//
// HARNESS RULE (copied from queries-analytics-dashboard-pg.test.ts): queries.ts
// reaches the database through getClient(), which binds to DATABASE_URL on
// first use, so the module-under-test (and schema) are DYNAMIC-imported
// AFTER createTestDbClient() has set DATABASE_URL + reset modules.
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';

// A timestamp at 02:00 UTC: America/New_York is UTC-4 (EDT) or UTC-5 (EST)
// year-round, so local wall-clock time there is always still the PREVIOUS
// calendar day at 02:00 UTC — this reproduces the mismatch regardless of
// when the suite runs / DST. Anchored 5 days before "now" (well inside any
// reasonable query window) rather than a hardcoded calendar date, so the
// test never goes stale.
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
const UTC_MIDNIGHT_5D_AGO = Math.floor(NOW / DAY) * DAY - 5 * DAY;
const BOUNDARY_TS = UTC_MIDNIGHT_5D_AGO + 2 * 60 * 60; // 02:00 UTC, 5 days ago
const EXPECTED_UTC_DAY = new Date(BOUNDARY_TS * 1000).toISOString().slice(0, 10);

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');

  // Force a single physical Postgres connection so the `SET TIME ZONE`
  // issued on it (below) is guaranteed to still be in effect for every later
  // query in this test — a pool with >1 connection could hand a later query
  // a fresh connection back at the server/database default TimeZone,
  // making the repro flaky rather than deterministic.
  const originalPoolMax = process.env.CCC_PG_POOL_MAX;
  process.env.CCC_PG_POOL_MAX = '1';

  const { client, cleanup } = await createTestDbClient('postgres');
  try {
    // Force the Postgres SESSION timezone off UTC — the exact scenario a
    // real non-UTC-configured RDS instance would produce, and the one
    // testcontainers' UTC-default postgres:16 image otherwise masks.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).execute(sql`SET TIME ZONE 'America/New_York'`);

    // Dynamic import AFTER the DATABASE_URL env + module reset (harness rule).
    const { schema } = await import('@/lib/db/schema');
    const queries = await import('@/lib/db/queries');
    const { getSnapshotsForUser, getAdoptionTrend } = queries;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).insert(schema.users).values([
      { id: 'tz-user', email: 'tz@test.local' },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).insert(schema.chatMessages).values([
      {
        id: 'tz-chm-1', user_id: 'tz-user', prompt_text: 'boundary',
        prompt_length: 8, occurred_at: BOUNDARY_TS,
      },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).insert(schema.coworkMessages).values([
      {
        id: 'tz-cw-1', session_id: 'tz-s1', user_id: 'tz-user',
        message_type: 'cowork_user_message', surface: 'cowork', occurred_at: BOUNDARY_TS,
      },
    ]);

    // ── Site queries.ts:389 — getSnapshotsForUser's fallback synthesis ────
    // No analytics_snapshots rows exist for tz-user, so this exercises the
    // dateExpr-based UNION ALL fallback directly.
    const snaps = await getSnapshotsForUser('tz-user', 3650);
    expect(snaps.map((s) => s.snapshot_date)).toContain(EXPECTED_UTC_DAY);
    const snapDay = snaps.find((s) => s.snapshot_date === EXPECTED_UTC_DAY);
    expect(snapDay?.surface_chat).toBe(1);
    expect(snapDay?.surface_cowork).toBe(1);

    // ── Site queries.ts:493 — getAdoptionTrend's live fallback ────────────
    // No analytics_snapshots rows anywhere, so the whole window is
    // live-derived via the dateExpr-based raw queries.
    const trend = await getAdoptionTrend(3650);
    const byDate = new Map(trend.map((t) => [t.date, t]));
    expect(byDate.has(EXPECTED_UTC_DAY)).toBe(true);
    expect(byDate.get(EXPECTED_UTC_DAY)?.surface_chat).toBe(1);
    expect(byDate.get(EXPECTED_UTC_DAY)?.surface_cowork).toBe(1);
  } finally {
    await cleanup();
    if (originalPoolMax === undefined) delete process.env.CCC_PG_POOL_MAX;
    else process.env.CCC_PG_POOL_MAX = originalPoolMax;
  }
}

describe('date-bucket UTC correctness under a non-UTC Postgres session TimeZone', () => {
  it(
    'still buckets by UTC when the session TimeZone is America/New_York — ' +
      'proves the AT TIME ZONE \'UTC\' fix at queries.ts:389/:493',
    async () => {
      await runSpec();
    },
    180_000,
  );
});
