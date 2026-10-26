// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres test harness: every database test runs on a fresh, migrated
// Postgres database from startPg() — a per-file database on the shared server
// named by CCC_TEST_PG_URL (CI, and local runs against ccc-postgres), or a
// postgres:16 testcontainer without it (needs Docker; pulls the image once).
// test/helpers/db.ts builds createTestDbClient()/createTestDatabase() on it.
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import path from 'node:path';
import { pgSchema } from '@/lib/db/schema.pg';

// Resolved relative to the drizzle-kit `out` folder convention (project
// root), NOT __dirname (which would be test/helpers under ts-node/vitest).
const MIGRATIONS_FOLDER = path.resolve(process.cwd(), 'lib/db/migrations-pg');

/**
 * Apply the committed drizzle-kit Postgres migrations (lib/db/migrations-pg)
 * against the database at `url`. Opens and closes its own pool — callers
 * that already have a pool (e.g. startPg()) don't need to call this
 * separately; it exists standalone so a test can migrate a Postgres instance
 * it obtained some other way (e.g. a shared CI database) without going
 * through testcontainers.
 */
export async function applyPgMigrations(url: string): Promise<void> {
  const pool = new Pool({ connectionString: url });
  try {
    await migrate(drizzle(pool, { schema: pgSchema }), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

/**
 * The part of a started container the tests use. A testcontainer satisfies
 * it, and so does the shared-server database below, whose stop() drops the
 * per-file database instead of stopping a container.
 */
export interface PgHandle {
  getConnectionUri(): string;
  stop(): Promise<unknown>;
}

export interface PgContext {
  container: PgHandle;
  url: string;
  pool: Pool;
}

// ── Shared-server mode ──────────────────────────────────────────────────────
// When CCC_TEST_PG_URL points at a Postgres server (a superuser connection,
// e.g. the CI service container), each startPg() call gets its own fresh
// database on that server, cloned from a template that has the migrations
// applied once, instead of starting a container per test file. Without the
// variable, startPg() starts a testcontainer exactly as before.
//
// Safety: this code only ever creates or drops databases whose names start
// with TEST_DB_PREFIX, and assertTestDbName() refuses anything else, so it
// cannot touch an application database on the same server.
export const TEST_DB_PREFIX = 'ccc_t_';
// Arbitrary constant, distinct from lib/db/migration-lock.ts and
// lib/db/scheduler-lock.ts, serialising template creation across the
// parallel vitest workers.
const TEMPLATE_LOCK_ID = 7_318_004_518;

/**
 * Creation time (epoch seconds) of a per-file test database, from its name;
 * null for a template or a name without one (an older naming scheme).
 */
export function testDbCreatedAt(name: string): number | null {
  const m = /^ccc_t_(\d{10})_/.exec(name);
  return m ? Number(m[1]) : null;
}

export function assertTestDbName(name: string): void {
  if (!/^ccc_t_[a-z0-9_]+$/.test(name)) {
    throw new Error(`refusing to touch database "${name}": not a ${TEST_DB_PREFIX}* test database`);
  }
}

function withDatabase(serverUrl: string, database: string): string {
  const u = new URL(serverUrl);
  u.pathname = `/${database}`;
  return u.toString();
}

/** Fingerprint of the committed migrations, so a schema change builds a new template. */
function migrationsFingerprint(): string {
  const files = fs.readdirSync(MIGRATIONS_FOLDER, { recursive: true }) as string[];
  const hash = crypto.createHash('sha256');
  for (const f of files.map(String).sort()) {
    const full = path.join(MIGRATIONS_FOLDER, f);
    if (fs.statSync(full).isFile()) {
      hash.update(f);
      hash.update(fs.readFileSync(full));
    }
  }
  return hash.digest('hex').slice(0, 12);
}

/** Name of the template database for the current migrations. */
export function currentTemplateName(): string {
  const name = `${TEST_DB_PREFIX}tpl_${migrationsFingerprint()}`;
  assertTestDbName(name);
  return name;
}

let templateReady: Promise<string> | null = null;

/** Create (once per server + schema) the migrated template database; returns its name. */
function ensureTemplate(serverUrl: string): Promise<string> {
  templateReady ??= (async () => {
    const name = currentTemplateName();
    const admin = new Pool({ connectionString: serverUrl, max: 1 });
    const conn = await admin.connect();
    try {
      await conn.query('SELECT pg_advisory_lock($1)', [TEMPLATE_LOCK_ID]);
      try {
        const { rows } = await conn.query(
          'SELECT datistemplate FROM pg_database WHERE datname = $1',
          [name],
        );
        if (rows.length === 0 || !rows[0].datistemplate) {
          // A half-built template (a crash between CREATE and the flag) is rebuilt.
          await conn.query(`DROP DATABASE IF EXISTS "${name}"`);
          await conn.query(`CREATE DATABASE "${name}"`);
          await applyPgMigrations(withDatabase(serverUrl, name));
          await conn.query(`ALTER DATABASE "${name}" WITH IS_TEMPLATE true`);
        }
      } finally {
        await conn.query('SELECT pg_advisory_unlock($1)', [TEMPLATE_LOCK_ID]);
      }
    } finally {
      conn.release();
      await admin.end();
    }
    return name;
  })();
  return templateReady;
}

async function startSharedPg(serverUrl: string): Promise<PgContext> {
  const template = await ensureTemplate(serverUrl);
  // Creation time (epoch seconds) leads the name so the start-of-run sweep can
  // tell a crashed run's leftovers from a concurrent run's live databases.
  const name = `${TEST_DB_PREFIX}${Math.floor(Date.now() / 1000)}_${process.pid}_${crypto.randomBytes(6).toString('hex')}`;
  assertTestDbName(name);
  const admin = new Pool({ connectionString: serverUrl, max: 1 });
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
  } finally {
    await admin.end();
  }
  const url = withDatabase(serverUrl, name);
  const pool = new Pool({ connectionString: url });
  const container: PgHandle = {
    getConnectionUri: () => url,
    async stop() {
      assertTestDbName(name);
      const drop = new Pool({ connectionString: serverUrl, max: 1 });
      try {
        // WITH (FORCE) ends any connection a test left open (PG 13+).
        await drop.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await drop.end();
      }
    },
  };
  return { container, url, pool };
}

/**
 * Start a fresh Postgres database, apply the drizzle-kit migrations, and
 * return a handle + connection string + a ready-to-use `pg.Pool`. A
 * postgres:16 testcontainer by default; a per-file database on a shared
 * server when CCC_TEST_PG_URL is set (see above).
 * Caller owns teardown: `await pool.end(); await container.stop();`
 * (or just use withPostgres() below, which does this for you).
 */
export async function startPg(): Promise<PgContext> {
  const shared = process.env.CCC_TEST_PG_URL;
  if (shared) return startSharedPg(shared);
  const container = await new PostgreSqlContainer('postgres:16').start();
  const url = container.getConnectionUri();
  await applyPgMigrations(url);
  const pool = new Pool({ connectionString: url });
  return { container, url, pool };
}

/**
 * Convenience wrapper: start a container, migrate it, hand the connection
 * string to `fn`, then always tear the container down — even if `fn` throws.
 *
 *   const rowCount = await withPostgres(async (url) => {
 *     const pool = new Pool({ connectionString: url });
 *     const { rows } = await pool.query('SELECT 1');
 *     await pool.end();
 *     return rows.length;
 *   });
 */
export async function withPostgres<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const { container, url, pool } = await startPg();
  try {
    return await fn(url);
  } finally {
    await pool.end();
    await container.stop();
  }
}
