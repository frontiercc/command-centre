// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The access audit log's append-only guarantee on Postgres.
// Testcontainers (postgres:16) — proves INSERT succeeds and UPDATE/DELETE are
// rejected by the DATABASE ITSELF (not app-level code).
//
// Requires Docker. Skipped (not failed) on a Docker-less box, matching the
// convention in test/pg-smoke.test.ts. Run explicitly with:
//   npx vitest run test/audit-immutability-pg.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { startPg, type PgHandle } from './helpers/pg';
import { applyAuditImmutabilityPg } from '@/lib/db/audit-db';

let container: PgHandle;
let pool: Pool;

describe('access_audit_log append-only immutability (Postgres)', () => {
  beforeAll(async () => {
    const ctx = await startPg();
    container = ctx.container;
    pool = ctx.pool;

    // applyAuditImmutabilityPg runs the same migration
    // (lib/db/migrations-pg-audit/0001_audit_immutability.sql) that
    // lib/db/client.ts's getAuditClient() postgres branch runs on a fresh
    // pool — creates access_audit_log + installs audit_no_update/
    // audit_no_delete.
    await applyAuditImmutabilityPg(pool);

    await pool.query(
      `INSERT INTO access_audit_log (actor_id, actor_email, resource, action, outcome)
       VALUES ('u1', 'alice@example.com', 'events', 'READ', 'success')`
    );
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('allows INSERT (append-only)', async () => {
    await expect(
      pool.query(
        `INSERT INTO access_audit_log (actor_id, actor_email, resource, action, outcome)
         VALUES ('u2', 'bob@example.com', 'events', 'READ', 'success')`
      )
    ).resolves.toBeTruthy();
  });

  it('rejects UPDATE on the audit log', async () => {
    await expect(
      pool.query(`UPDATE access_audit_log SET outcome = 'denied' WHERE actor_id = 'u1'`)
    ).rejects.toThrow(/append-only/);
  });

  it('rejects DELETE on the audit log', async () => {
    await expect(pool.query(`DELETE FROM access_audit_log WHERE actor_id = 'u1'`)).rejects.toThrow(
      /append-only/
    );
  });

  it('rejects invalid action values (CHECK constraint)', async () => {
    await expect(
      pool.query(
        `INSERT INTO access_audit_log (actor_id, actor_email, resource, action, outcome)
         VALUES ('u3', 'carol@example.com', 'events', 'HACK', 'success')`
      )
    ).rejects.toThrow();
  });
});
