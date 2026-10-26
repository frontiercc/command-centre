// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// a production deployment (the instance where this bug was found and fixed) runs Postgres.
// This file runs the runUserCleanup() grace-period assertions against a real
// Postgres database via createTestDbClient (mirrors
// test/queries-users-pg.test.ts). Skipped (not failed) without Docker.
import { describe, it, expect } from 'vitest';

const NOW = Math.floor(Date.now() / 1000);
const daysAgo = (d: number) => NOW - d * 86400;

describe('runUserCleanup — postgres', () => {
  it('never-seen users get a grace period, stale/active users behave as before', async () => {
    const { createTestDbClient } = await import('./helpers/db');
    const { client, cleanup } = await createTestDbClient('postgres');
    try {
      // Dynamic import AFTER createTestDbClient() sets the DB env + resets
      // modules (harness rule — the database client binds to DATABASE_URL on first use).
      const { schema } = await import('@/lib/db/schema');
      const { runUserCleanup } = await import('@/lib/jobs/user-cleanup');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (client as any).insert(schema.users).values([
        { id: 'pg-new', email: 'pg.new@example.com', source: 'otel', first_seen_at: daysAgo(2), last_seen_at: null },
        { id: 'pg-stale-new', email: 'pg.stale.new@example.com', source: 'otel', first_seen_at: daysAgo(40), last_seen_at: null },
        { id: 'pg-went-quiet', email: 'pg.went.quiet@example.com', source: 'otel', first_seen_at: daysAgo(90), last_seen_at: daysAgo(40) },
        { id: 'pg-active', email: 'pg.active@example.com', source: 'otel', first_seen_at: daysAgo(90), last_seen_at: daysAgo(5) },
      ]);

      const result = await runUserCleanup();
      expect(result.deactivated).toBe(2); // pg-stale-new + pg-went-quiet

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await (client as any).select().from(schema.users);
      const byId = Object.fromEntries(rows.map((r: { id: string }) => [r.id, r]));

      expect(byId['pg-new'].deactivated_at).toBeNull();
      expect(byId['pg-stale-new'].deactivated_at).not.toBeNull();
      expect(byId['pg-stale-new'].deactivation_reason).toBe('stale_otel_auto');
      expect(byId['pg-went-quiet'].deactivated_at).not.toBeNull();
      expect(byId['pg-active'].deactivated_at).toBeNull();
    } finally {
      await cleanup();
    }
  }, 60000);
});
