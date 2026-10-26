// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// getClient() migrates the schema on first open. With one application
// instance that is safe. With several starting at once — which is exactly
// what a rolling deploy or an autoscale event produces — they would all run
// the migrator against the same database simultaneously.
//
// withMigrationLock() serialises that step through a Postgres advisory lock:
// the first instance migrates while the others WAIT (they must not skip, or
// they would carry on against a half-migrated schema), then proceed once it
// has finished.
import { describe, it, expect } from 'vitest';

describe('withMigrationLock (postgres)', () => {
  it(
    'serialises concurrent migrators — they wait rather than overlap or skip',
    async () => {
      const { startPg } = await import('./helpers/pg');
      const { withMigrationLock } = await import('@/lib/db/migration-lock');
      const { container, pool, url } = await startPg();

      try {
        const events: string[] = [];
        let overlapping = 0;
        let maxOverlap = 0;

        const worker = (name: string) =>
          withMigrationLock(pool, async () => {
            overlapping += 1;
            maxOverlap = Math.max(maxOverlap, overlapping);
            events.push(`enter:${name}`);
            await new Promise((r) => setTimeout(r, 120));
            events.push(`exit:${name}`);
            overlapping -= 1;
            return name;
          });

        const results = await Promise.all([worker('a'), worker('b'), worker('c')]);

        // Every caller ran — waiting, never skipping. A skipped migrator would
        // leave that instance serving against an un-migrated schema.
        expect(results.sort()).toEqual(['a', 'b', 'c']);
        // ...and never at the same time as another.
        expect(maxOverlap).toBe(1);
        // Each enter is immediately followed by its own exit.
        for (let i = 0; i < events.length; i += 2) {
          expect(events[i + 1]).toBe(events[i].replace('enter:', 'exit:'));
        }

        // The lock is released afterwards, so a later boot is not blocked.
        // pg_locks is server-wide; count only this test's database, since a
        // shared test server (CCC_TEST_PG_URL) also holds other files' locks.
        const held = await pool.query(
          "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
        );
        expect(held.rows[0].n).toBe(0);

        // REGRESSION (found by test/queries-date-bucket-tz-pg.test.ts): the
        // lock holds a connection for its whole lifetime, so if the migration
        // asked the SAME pool for a second connection it would wait forever on
        // a single-connection pool (CCC_PG_POOL_MAX=1 is a supported setting).
        // The locked connection is therefore HANDED to the callback to work on.
        const { Pool } = await import('pg');
        const single = new Pool({ connectionString: url, max: 1 });
        try {
          const onOneConnection = await withMigrationLock(single, async (conn) => {
            const r = await conn.query('SELECT 1 AS ok');
            return r.rows[0].ok as number;
          });
          expect(onOneConnection).toBe(1);
        } finally {
          await single.end();
        }

        // The callback's failure must not leave the lock held.
        await expect(
          withMigrationLock(pool, async () => {
            throw new Error('migration blew up');
          }),
        ).rejects.toThrow('migration blew up');
        const afterFailure = await pool.query(
          "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
        );
        expect(afterFailure.rows[0].n).toBe(0);
      } finally {
        await pool.end();
        await container.stop();
      }
    },
    180_000,
  );
});
