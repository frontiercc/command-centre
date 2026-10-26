// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import path from 'path';
import { vi } from 'vitest';
import type { DrizzleClient } from '@/lib/db/client';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Clear the process-global getClient()/getAuditClient() singletons
 * (lib/db/client.ts) between test-helper calls, ending each pool first.
 *
 * $client is drizzle-orm's escape hatch to the raw driver instance bound at
 * construction — the pg.Pool passed into drizzle(). An un-ended pool left
 * connected when its database is dropped surfaces as an unhandled 'error'
 * event ("terminating connection due to administrator command") that vitest
 * reports against a LATER test, so end it before deleting the singleton.
 */
async function clearClientSingletons(): Promise<void> {
  const proc = process as unknown as Record<string, { $client?: { end?: () => Promise<void> } } | undefined>;
  for (const key of ['__ccc_client', '__ccc_audit_client'] as const) {
    try {
      await proc[key]?.$client?.end?.();
    } catch {
      /* already closed */
    }
  }
  delete proc.__ccc_client;
  delete proc.__ccc_client_promise;
  delete proc.__ccc_pgpool;
  delete proc.__ccc_audit_client;
  delete proc.__ccc_audit_client_promise;
  delete proc.__ccc_audit_pgpool;
}

/**
 * A fresh, fully migrated Postgres database for one test file, with the
 * application's getClient() bound to it:
 *
 *   const { client, cleanup } = await createTestDbClient();
 *   // client is a NodePgDatabase bound to lib/db/schema.pg.ts
 *   await cleanup();
 *
 * The database comes from startPg() (test/helpers/pg.ts): a per-file
 * database on the shared server when CCC_TEST_PG_URL is set (CI, and local
 * runs against the running ccc-postgres), otherwise a postgres:16
 * testcontainer. startPg() applies the committed lib/db/migrations-pg set;
 * getClient()'s own migrate on first open is then an idempotent no-op.
 *
 * The optional argument is accepted for call sites written when the helper
 * served two dialects; Postgres is the only one.
 */
export async function createTestDbClient(
  _dialect?: 'postgres',
): Promise<{ client: DrizzleClient; cleanup: () => Promise<void> }> {
  const { startPg } = await import('./pg');
  const { container, url, pool } = await startPg();

  const saved = {
    DATABASE_URL: process.env.DATABASE_URL,
    CCC_PG_SSL: process.env.CCC_PG_SSL,
  };
  process.env.DATABASE_URL = url;
  // lib/db/client.ts's buildPgPool() defaults to SSL-required; the test
  // servers don't speak SSL, so without this every query fails with
  // "The server does not support SSL connections".
  process.env.CCC_PG_SSL = 'disable';
  const originalCwd = process.cwd();
  process.chdir(PROJECT_ROOT); // migrations resolve from the project root

  await clearClientSingletons();
  vi.resetModules();
  const { getClient } = await import('@/lib/db/client');
  const client = await getClient();

  return {
    client,
    async cleanup() {
      await clearClientSingletons();
      await pool.end();
      await container.stop();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      process.chdir(originalCwd);
    },
  };
}

/**
 * createTestDbClient() plus a raw-SQL handle (test/helpers/sql.ts) for
 * seeding and inspecting the database:
 *
 *   const { sql, cleanup } = await createTestDatabase();
 *   await sql.run('INSERT INTO users (id, email) VALUES (?, ?)', ['u1', 'a@b.c']);
 *
 * Application code under test reaches the same database through getClient(),
 * as it does in production.
 */
export async function createTestDatabase(): Promise<{
  client: DrizzleClient;
  sql: import('./sql').TestSql;
  cleanup: () => Promise<void>;
}> {
  const { pgTestSql } = await import('./sql');
  const { client, cleanup } = await createTestDbClient();
  const pool = (client as unknown as { $client: import('pg').Pool }).$client;
  return { client, sql: pgTestSql(pool), cleanup };
}
