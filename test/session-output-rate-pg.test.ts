// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres leg for the session output rate READ path. The write path (the
// session aggregator populating produced_output) is covered by
// test/pulse-cowork-aggregator-classifier-pg.test.ts; the wider read-path
// suite is test/session-output-rate.test.ts.
//
// Worth its own leg because Postgres returns integer columns as STRINGS
// through this driver, so `produced_output === 1` would be false for every
// row that actually produced something — the rate would silently read 0%.
// Same class of trap as the Policy B Number() coercions elsewhere in the
// codebase.
//
// createTestDbClient('postgres') runs the full lib/db/migrations-pg set via
// startPg(), so no per-test DDL is needed — which also means this leg fails
// if 0020_session_output is ever dropped from meta/_journal.json again.
//
// HARNESS RULE: lib/pulse/** reaches the database through getClient(), which
// binds to DATABASE_URL on first use, so the module under test is
// DYNAMIC-imported after createTestDbClient() has set DATABASE_URL + reset
// modules.
import { describe, it, expect } from 'vitest';

const WEEK = 7 * 24 * 60 * 60;
const NOW = 1_757_937_600;

describe('session output rate (postgres)', () => {
  it('reads produced_output correctly when the driver hands integers back as strings', async () => {
    const { createTestDbClient } = await import('./helpers/db');
    const { client, cleanup } = await createTestDbClient('postgres');

    try {
      const { schema } = await import('@/lib/db/schema');
      const mod = await import('@/lib/pulse/cowork/session-output-rate');
      const { weekStarts } = await import('@/lib/pulse/period');

      const windowWeeks = weekStarts(NOW - WEEK, mod.OUTPUT_RATE_WEEKS);
      const lastCompleted = windowWeeks[windowWeeks.length - 1];
      const startedAt = lastCompleted + 3600;

      // Cast to `any` for the raw inserts — the established cast in every
      // other *-pg test (config-pg, admin-queries-pg).
      const db = client as any;

      await db.insert(schema.users).values({ id: 'user-1', email: 'pg-output@test.local' });

      // 3 produced, 1 did not, 1 not yet aggregated (must be excluded entirely).
      const flags: Array<0 | 1 | null> = [1, 1, 1, 0, null];
      for (let i = 0; i < flags.length; i++) {
        const sessionId = `pg-sess-${i}`;
        await db.insert(schema.coworkSessions).values({
          id: sessionId,
          conversation_id: `pg-conv-${i}`,
          user_id: 'user-1',
          started_at: startedAt,
        });
        await db.insert(schema.coworkSessionStats).values({
          session_id: sessionId,
          user_id: 'user-1',
          first_event_at: startedAt,
          last_event_at: startedAt + 60,
          produced_output: flags[i],
          computed_at: startedAt,
        });
      }

      const report = await mod.buildSessionOutputRate(NOW);

      // 4 measured (the NULL row is excluded, not counted as a miss), 3 produced.
      expect(report.sessions).toBe(4);
      expect(report.produced).toBe(3);
      expect(report.rate).toBeCloseTo(0.75, 6);
      expect(report.hasData).toBe(true);

      const week = report.weeks.find((w) => w.weekStart === lastCompleted)!;
      expect(week.sessions).toBe(4);
      expect(week.produced).toBe(3);

      // Every other week in the window is measured-empty, never zero-faked.
      for (const w of report.weeks.filter((x) => x.weekStart !== lastCompleted)) {
        expect(w.sessions).toBe(0);
        expect(w.rate).toBeNull();
      }
    } finally {
      await cleanup();
    }
  }, 120_000);
});
