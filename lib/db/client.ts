// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Drizzle client factory for the Postgres database (DATABASE_URL). Postgres is the
// only database.
//
// Singleton on `process`: Next.js standalone builds bundle this module into
// multiple webpack chunks, each with its own module scope, so a module-level
// `let client` would open a separate pool per chunk. `process` is the one
// Node.js built-in shared across all of them.
//
// Migration bootstrap: the first getClient() in a process runs drizzle-orm's
// node-postgres migrator over lib/db/migrations-pg (tracked in drizzle's own
// migrations table; idempotent) before handing the client out, so the app
// never queries an un-migrated database. The audit connection bootstraps its
// own table and append-only triggers — see getAuditClient() below.
import path from 'node:path';
// Type-only: `drizzle()`'s return type is `NodePgDatabase<T> & { $client: Pool }`
// — the `$client` escape hatch to the pool lives on that intersection, not on
// the bare NodePgDatabase class, so the client types are derived via ReturnType.
import type { drizzle as drizzlePg, NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool as PgPool, ClientConfig } from 'pg';
import { pgSchema } from './schema.pg';
import { auditPgSchema } from './schema-audit';
import { pgSslOption } from './pg-ssl';

export type DrizzleClient = ReturnType<typeof drizzlePg<typeof pgSchema>>;

export type DrizzleAuditClient = ReturnType<typeof drizzlePg<typeof auditPgSchema>>;

type Holder = {
  __ccc_client?: DrizzleClient;
  __ccc_client_promise?: Promise<DrizzleClient>;
  __ccc_pgpool?: PgPool;
  __ccc_audit_client?: DrizzleAuditClient;
  __ccc_audit_client_promise?: Promise<DrizzleAuditClient>;
  __ccc_audit_pgpool?: PgPool;
};
const proc = process as unknown as Holder;

/**
 * The ONE place the Postgres connection parameters live. Used by the app pool
 * (below) and by the scheduler leader election (lib/db/scheduler-lock.ts),
 * which opens a dedicated pg.Client outside the pool and must still speak TLS
 * to RDS exactly as the pool does (TLS per lib/db/pg-ssl.ts + the RDS CA via
 * NODE_EXTRA_CA_CERTS). A second copy of this mapping would drift.
 */
export function pgConnectionConfig(): Pick<ClientConfig, 'connectionString' | 'ssl'> {
  return {
    connectionString: process.env.DATABASE_URL,
    ssl: pgSslOption(process.env.CCC_PG_SSL, process.env.DATABASE_URL),
  };
}

export function buildPgPool(Pool: typeof PgPool): PgPool {
  const pool = new Pool({
    ...pgConnectionConfig(),
    max: Number(process.env.CCC_PG_POOL_MAX ?? 10),
  });
  // node-postgres emits 'error' on the POOL when an IDLE client's backend
  // connection dies (RDS failover/maintenance kill = FATAL 57P01; a stopping
  // testcontainer in CI). With no listener that is an unhandled 'error'
  // event — a process crash in production, a failed vitest run in CI. Log
  // and swallow: the dead client is already discarded by the pool, and the
  // next query checks out a fresh connection (getClient()'s existing
  // connection-resilience retry covers the acquire path).
  pool.on('error', (err) => {
    console.error('[db] idle pg client error (connection dropped, pool will replace it):', err.message);
  });
  return pool;
}

/**
 * Drizzle client for the main database (DATABASE_URL), bound to the Postgres
 * schema. Singleton per process.
 */
export async function getClient(): Promise<DrizzleClient> {
  if (proc.__ccc_client) return proc.__ccc_client;
  if (proc.__ccc_client_promise) return proc.__ccc_client_promise;

  // Assign the in-flight promise SYNCHRONOUSLY (before the first await) so
  // concurrent callers that arrive before construction finishes share this
  // one promise instead of each racing past the null-check above and
  // constructing their own pg.Pool — the loser's pool would
  // otherwise leak silently (a whole idle Postgres pool, for the process
  // lifetime).
  const promise = (async (): Promise<DrizzleClient> => {
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { Pool } = await import('pg');
    const pool = buildPgPool(Pool);
    proc.__ccc_pgpool = pool;
    const db = drizzle(pool, { schema: pgSchema });
    // Same migrator + folder as test/helpers/pg.ts. Idempotent: drizzle
    // tracks applied migrations, so a re-run (e.g. a container already
    // migrated by startPg() in tests) is a no-op. Runs BEFORE the client is
    // handed out, inside this once-per-process promise.
    //
    // Held under an advisory lock (lib/db/migration-lock.ts) so several
    // instances starting at once — a rolling deploy overlaps the new task
    // with the draining one, an autoscale event starts several together —
    // migrate one at a time instead of racing. The others BLOCK until the
    // first finishes, then run the migrator themselves as a no-op; none
    // proceeds to serve traffic against a half-migrated schema.
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const { withMigrationLock } = await import('./migration-lock');
    await withMigrationLock(pool, (conn) =>
      // Migrate ON the locked connection, not through the pool: the lock
      // holds that connection for its whole lifetime, so going back to the
      // pool would deadlock whenever the pool has one connection
      // (CCC_PG_POOL_MAX=1).
      migrate(drizzle(conn, { schema: pgSchema }), {
        migrationsFolder: path.resolve(process.cwd(), 'lib/db/migrations-pg'),
      }),
    );
    proc.__ccc_client = db;
    return proc.__ccc_client;
  })();
  proc.__ccc_client_promise = promise;
  // Connection resilience (A1): if construction REJECTS (a transient DB blip at
  // boot, an RDS failover mid-open), don't leave the rejected promise cached —
  // otherwise every later getClient() returns that same poisoned rejection and
  // the process is wedged until restart. Clear the cache (only if it's still
  // this promise, so we never stomp a newer attempt) and release any half-built
  // pg pool so the next call retries cleanly. The `.catch` also marks the
  // internal chain handled; the caller still observes the original rejection.
  promise.catch(() => {
    if (proc.__ccc_client_promise === promise) proc.__ccc_client_promise = undefined;
    const pool = proc.__ccc_pgpool;
    if (pool) {
      proc.__ccc_pgpool = undefined;
      void pool.end().catch(() => { /* pool never fully connected */ });
    }
  });

  return promise;
}

/**
 * getClient() typed as the plain NodePgDatabase over the Postgres schema — the
 * type every query site uses (`const client = await getTypedClient();`).
 */
export async function getTypedClient(): Promise<NodePgDatabase<typeof pgSchema>> {
  return (await getClient()) as unknown as NodePgDatabase<typeof pgSchema>;
}

/**
 * Drizzle client for the audit table (access_audit_log) — its own pool against
 * the same DATABASE_URL, independent of getClient(). Before it is handed out,
 * applyAuditImmutabilityPg() makes the table append-only (idempotent DDL).
 */
export async function getAuditClient(): Promise<DrizzleAuditClient> {
  if (proc.__ccc_audit_client) return proc.__ccc_audit_client;
  if (proc.__ccc_audit_client_promise) return proc.__ccc_audit_client_promise;

  // Same in-flight-promise cache as getClient() above — assigned
  // synchronously before the first await so concurrent first-callers share
  // one construction instead of each opening their own audit pool.
  const promise = (async (): Promise<DrizzleAuditClient> => {
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { Pool } = await import('pg');
    const { applyAuditImmutabilityPg } = await import('./audit-db');
    const { withMigrationLock } = await import('./migration-lock');
    const pool = buildPgPool(Pool);
    // Creates access_audit_log + its append-only triggers on a fresh pool
    // before it's handed out. Same advisory lock as the main schema migration above. The DDL is
    // idempotent (IF NOT EXISTS / OR REPLACE), but concurrent CREATE ... IF
    // NOT EXISTS against one Postgres can still collide in the catalogue, so
    // instances starting together serialise here too.
    await withMigrationLock(pool, (conn) => applyAuditImmutabilityPg(conn));
    proc.__ccc_audit_pgpool = pool;
    proc.__ccc_audit_client = drizzle(pool, { schema: auditPgSchema });
    return proc.__ccc_audit_client;
  })();
  proc.__ccc_audit_client_promise = promise;
  // Connection resilience (A1) — same rationale as getClient() above: clear the
  // cached promise (and any half-built audit pool) on rejection so a boot-time
  // DB blip doesn't wedge the audit path for the process lifetime.
  promise.catch(() => {
    if (proc.__ccc_audit_client_promise === promise) proc.__ccc_audit_client_promise = undefined;
    const pool = proc.__ccc_audit_pgpool;
    if (pool) {
      proc.__ccc_audit_pgpool = undefined;
      void pool.end().catch(() => { /* pool never fully connected */ });
    }
  });

  return promise;
}
