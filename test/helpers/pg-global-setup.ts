// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Vitest global setup for shared-server Postgres mode. Does nothing
// unless CCC_TEST_PG_URL is set. When it is, before any test file starts:
//   1. drops per-file test databases a crashed earlier run left behind (older
//      than LEFTOVER_AGE_S, so a concurrent run's live databases survive), and
//      templates for older migrations (only ccc_t_* names, never anything else);
//   2. builds the migrated template once, so parallel workers don't queue
//      on the template lock at start-up.
// There is no teardown sweep: each file drops its own database on cleanup, and
// sweeping at the end of one run would delete another run's live databases.
import { Pool } from 'pg';

// A test file finishes in minutes; anything this old is a crashed run's.
const LEFTOVER_AGE_S = 2 * 60 * 60;

// Drops ccc_t_* databases that belong to no live run: per-file databases older
// than LEFTOVER_AGE_S (or named before timestamps were added), and templates
// built for an older set of migrations. Never the current template.
async function dropLeftovers(serverUrl: string): Promise<number> {
  const { TEST_DB_PREFIX, assertTestDbName, currentTemplateName, testDbCreatedAt } = await import('./pg');
  const cutoff = Math.floor(Date.now() / 1000) - LEFTOVER_AGE_S;
  const keep = currentTemplateName();
  const admin = new Pool({ connectionString: serverUrl, max: 1 });
  try {
    const { rows } = await admin.query<{ datname: string; datistemplate: boolean }>(
      `SELECT datname, datistemplate FROM pg_database WHERE datname LIKE $1 AND datname <> $2`,
      [`${TEST_DB_PREFIX.replace(/_/g, '\\_')}%`, keep],
    );
    let dropped = 0;
    for (const { datname, datistemplate } of rows) {
      assertTestDbName(datname);
      const createdAt = testDbCreatedAt(datname);
      if (!datistemplate && createdAt !== null && createdAt > cutoff) continue;
      if (datistemplate) await admin.query(`ALTER DATABASE "${datname}" WITH IS_TEMPLATE false`);
      await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
      dropped++;
    }
    return dropped;
  } finally {
    await admin.end();
  }
}

export async function setup(): Promise<void> {
  const serverUrl = process.env.CCC_TEST_PG_URL;
  if (!serverUrl) return;
  const dropped = await dropLeftovers(serverUrl);
  if (dropped > 0) console.log(`[pg-global-setup] dropped ${dropped} leftover test database(s)`);
  const { startPg } = await import('./pg');
  // Building one throwaway database forces the template into existence.
  const { container, pool } = await startPg();
  await pool.end();
  await container.stop();
}
