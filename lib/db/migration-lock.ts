// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// getClient() migrates the schema on first open (lib/db/client.ts). With one
// application instance that is safe. With several starting at once — a rolling
// deploy starts the new task before draining the old, and an autoscale event
// starts several at once — they would all run the migrator against the same
// database simultaneously.
//
// This serialises that step through a Postgres ADVISORY lock. The first
// instance migrates; the others block until it finishes and then run the
// migrator themselves, which is a no-op because drizzle records what it has
// applied. They WAIT rather than skip: skipping would let an instance serve
// traffic against a half-migrated schema, which is the failure this exists to
// prevent.
import type { Pool, PoolClient } from 'pg';

// Any stable 64-bit constant works; it only has to be unique within this
// database. Advisory locks are namespaced by value, not by table, so this
// number IS the lock's identity — never reuse it for anything else.
export const MIGRATION_LOCK_ID = 4_726_301_180_000_001;

/**
 * Run `fn` while holding the schema-migration advisory lock, on a connection
 * dedicated to it for the lock's whole lifetime.
 *
 * The lock belongs to the CONNECTION that took it, so the connection is
 * checked out of the pool up front and only released once the lock is
 * released — handing it back early would drop the lock silently while the
 * migration was still running.
 *
 * That connection is HANDED TO `fn` and the migration must run on it. Asking
 * the same pool for a second connection instead would wait forever whenever
 * the pool has a single connection (CCC_PG_POOL_MAX=1 is a supported setting,
 * and test/queries-date-bucket-tz-pg.test.ts uses exactly that) — the lock
 * holds the only connection while the migration queues behind it.
 */
export async function withMigrationLock<T>(
  pool: Pool,
  fn: (conn: PoolClient) => Promise<T>,
): Promise<T> {
  const conn = await pool.connect();
  let locked = false;
  try {
    // Blocking acquire, not pg_try_advisory_lock: a second instance must wait
    // for the migration to finish, never carry on without it.
    await conn.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    locked = true;
    return await fn(conn);
  } finally {
    if (locked) {
      // Best-effort: a failed unlock must not mask the original error, and the
      // lock is released by the server anyway when the session ends.
      try {
        await conn.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
      } catch { /* released on session end */ }
    }
    conn.release();
  }
}
