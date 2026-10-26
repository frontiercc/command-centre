// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import fs from 'fs';
import path from 'path';
import type { Pool, PoolClient } from 'pg';

/**
 * Creates access_audit_log (if missing) and (re)installs its append-only
 * triggers (audit_no_update / audit_no_delete) — the exact DDL is
 * lib/db/migrations-pg-audit/0001_audit_immutability.sql.
 *
 * Called from lib/db/client.ts's getAuditClient() right after it builds its
 * pool, so a fresh audit connection is immutable by construction.
 *
 * Idempotent (the migration file is CREATE ... IF NOT EXISTS / CREATE OR
 * REPLACE throughout), so calling this on every getAuditClient() construction
 * is cheap and safe — it does not need its own "already ran" guard.
 */
// Accepts a pooled CONNECTION as well as a Pool: lib/db/client.ts runs this
// under the migration advisory lock, which holds one connection for its whole
// lifetime, so the DDL must run on that same connection rather than queue
// behind it for another (a deadlock on a single-connection pool).
export async function applyAuditImmutabilityPg(pool: Pool | PoolClient): Promise<void> {
  const sqlPath = path.resolve(
    process.cwd(),
    'lib/db/migrations-pg-audit/0001_audit_immutability.sql'
  );
  const migrationSql = fs.readFileSync(sqlPath, 'utf-8');
  await pool.query(migrationSql);
}
