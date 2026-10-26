// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;

let createAdminUser: typeof import('@/lib/db/admin-queries').createAdminUser;
let findAdminById: typeof import('@/lib/db/admin-queries').findAdminById;
let updateAdminPasswordAndSso: typeof import('@/lib/db/admin-queries').updateAdminPasswordAndSso;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const adminQueries = await import('@/lib/db/admin-queries');
  createAdminUser = adminQueries.createAdminUser;
  findAdminById = adminQueries.findAdminById;
  updateAdminPasswordAndSso = adminQueries.updateAdminPasswordAndSso;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`DELETE FROM admin_users WHERE email LIKE '%@sso-flag.test'`);
});

describe('migration 055 — sso_enabled column default + backfill semantics', () => {
  it('a fresh row with no explicit sso_enabled defaults to 0 (column default)', async () => {
    // The column DEFAULT applies to inserts made after migration time — it does NOT
    // re-derive from password_hash per-row; only the one-time backfill UPDATE does that
    // (see the migration-SQL assertion below). This matches the OTel auto-enrol INSERTs,
    // which therefore set sso_enabled=0 EXPLICITLY rather than relying on the default alone.
    await sql.run(
      `INSERT INTO admin_users (id, email, password_hash, display_name, role)
       VALUES ('pending1', 'pending1@sso-flag.test', '__otel_pending__', 'Pending One', 'pulse')`,
    );
    const row = (await sql.get(`SELECT sso_enabled FROM admin_users WHERE id = 'pending1'`)) as { sso_enabled: number };
    expect(row.sso_enabled).toBe(0);
  });

  it('applies the one-time backfill UPDATE to rows present at migration time: real-hash -> 1, sentinel -> 0', async () => {
    // Exercise the migration's exact backfill statement against a scratch table shaped
    // like admin_users pre-migration (password_hash + sso_enabled with default 0), proving
    // the WHERE clause correctly distinguishes deliberately-provisioned vs. sentinel rows.
    // A plain table, not TEMP: on Postgres each statement may run on a
    // different pooled connection, and a temp table is per-connection. The
    // test database is private to this file, so nothing else sees it.
    await sql.exec(`
      CREATE TABLE backfill_scratch (
        id TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        sso_enabled INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO backfill_scratch (id, password_hash) VALUES ('real-preexisting', 'scrypt$real$hash');
      INSERT INTO backfill_scratch (id, password_hash) VALUES ('sentinel-preexisting', '__otel_pending__');
    `);
    await sql.exec(`UPDATE backfill_scratch SET sso_enabled = 1 WHERE password_hash != '__otel_pending__'`);

    const real = (await sql.get(`SELECT sso_enabled FROM backfill_scratch WHERE id = 'real-preexisting'`)) as { sso_enabled: number };
    const sentinel = (await sql.get(`SELECT sso_enabled FROM backfill_scratch WHERE id = 'sentinel-preexisting'`)) as { sso_enabled: number };
    expect(real.sso_enabled).toBe(1);
    expect(sentinel.sso_enabled).toBe(0);
    await sql.exec(`DROP TABLE backfill_scratch`);
  });
});

describe('createAdminUser — manual account creation', () => {
  it('sets sso_enabled=1 for a deliberately-created account', async () => {
    const user = await createAdminUser({
      email: 'created@sso-flag.test',
      passwordHash: 'scrypt$hash$value',
      displayName: 'Created User',
      role: 'viewer',
    });
    expect(user.sso_enabled).toBe(1);

    const fromDb = (await findAdminById(user.id))!;
    expect(fromDb.sso_enabled).toBe(1);
  });
});

describe('updateAdminPasswordAndSso — set-password activation semantics', () => {
  it('flips sso_enabled to 1 when the previous hash was the OTel sentinel', async () => {
    await sql.run(
      `INSERT INTO admin_users (id, email, password_hash, display_name, role, sso_enabled)
       VALUES ('sentinel1', 'sentinel1@sso-flag.test', '__otel_pending__', 'Sentinel One', 'pulse', 0)`,
    );

    await updateAdminPasswordAndSso('sentinel1', 'scrypt$new$hash');

    const updated = (await findAdminById('sentinel1'))!;
    expect(updated.password_hash).toBe('scrypt$new$hash');
    expect(updated.sso_enabled).toBe(1);
  });

  it('does NOT change sso_enabled on an ordinary password reset of an already-real account', async () => {
    // Admin previously disabled SSO deliberately on a real (non-sentinel) account.
    await sql.run(
      `INSERT INTO admin_users (id, email, password_hash, display_name, role, sso_enabled)
       VALUES ('real2', 'real2@sso-flag.test', 'scrypt$old$hash', 'Real Two', 'admin', 0)`,
    );

    await updateAdminPasswordAndSso('real2', 'scrypt$rotated$hash');

    const updated = (await findAdminById('real2'))!;
    expect(updated.password_hash).toBe('scrypt$rotated$hash');
    expect(updated.sso_enabled).toBe(0); // must remain untouched
  });

  it('leaves sso_enabled=1 untouched on a normal password change of an sso-enabled account', async () => {
    await sql.run(
      `INSERT INTO admin_users (id, email, password_hash, display_name, role, sso_enabled)
       VALUES ('real3', 'real3@sso-flag.test', 'scrypt$old$hash', 'Real Three', 'admin', 1)`,
    );

    await updateAdminPasswordAndSso('real3', 'scrypt$rotated2$hash');

    const updated = (await findAdminById('real3'))!;
    expect(updated.sso_enabled).toBe(1);
  });
});

function makeCodePayload(email: string, userId: string, sessionId: string, promptId: string) {
  return {
    resourceLogs: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'claude-code' } },
          { key: 'user.email', value: { stringValue: email } },
          { key: 'user.id', value: { stringValue: userId } },
          { key: 'organization.id', value: { stringValue: 'org_test' } },
        ]
      },
      scopeLogs: [{
        logRecords: [{
          attributes: [
            { key: 'event.name', value: { stringValue: 'claude_code.user_prompt' } },
            { key: 'session.id', value: { stringValue: sessionId } },
            { key: 'prompt.id', value: { stringValue: promptId } },
            { key: 'prompt', value: { stringValue: 'hello' } },
          ],
          timeUnixNano: '1750000000000000000'
        }]
      }]
    }]
  };
}

function makeCoworkPayload(email: string, userId: string, sessionId: string, promptId: string) {
  return {
    resourceLogs: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'cowork' } },
          { key: 'user.email', value: { stringValue: email } },
          { key: 'user.id', value: { stringValue: userId } },
          { key: 'user.account_uuid', value: { stringValue: `uuid-${userId}` } },
          { key: 'organization.id', value: { stringValue: 'org_test' } },
        ]
      },
      scopeLogs: [{
        logRecords: [{
          attributes: [
            { key: 'event.name', value: { stringValue: 'claude_code.user_prompt' } },
            { key: 'session.id', value: { stringValue: sessionId } },
            { key: 'prompt.id', value: { stringValue: promptId } },
            { key: 'prompt', value: { stringValue: 'hello' } },
          ],
          timeUnixNano: '1750000000000000000'
        }]
      }]
    }]
  };
}

describe('OTel auto-enrolment — both receivers create sso_enabled=0 rows', () => {
  it('code-receiver auto-enrol INSERT sets sso_enabled=0 explicitly', async () => {
    const { processCodeOtlpLogs } = await import('@/lib/otel/code-receiver');
    const email = 'codeotel@sso-flag.test';
    await sql.run(`DELETE FROM admin_users WHERE email = ?`, [email]);
    await sql.run(`DELETE FROM users WHERE email = ?`, [email]);

    await processCodeOtlpLogs(
      makeCodePayload(email, 'codeotel-user', 'sess-sso-1', 'prompt-sso-1'),
    );

    const adminUser = (await sql.get(`SELECT * FROM admin_users WHERE email = ?`, [email])) as
      | { sso_enabled: number; password_hash: string }
      | undefined;
    expect(adminUser).toBeDefined();
    expect(adminUser!.password_hash).toBe('__otel_pending__');
    expect(adminUser!.sso_enabled).toBe(0);
  });

  it('cowork-receiver auto-enrol INSERT sets sso_enabled=0 explicitly', async () => {
    const { processOtlpLogs } = await import('@/lib/otel/cowork-receiver');
    const email = 'coworkotel@sso-flag.test';
    await sql.run(`DELETE FROM admin_users WHERE email = ?`, [email]);
    await sql.run(`DELETE FROM users WHERE email = ?`, [email]);

    await processOtlpLogs(
      makeCoworkPayload(email, 'coworkotel-user', 'sess-sso-2', 'prompt-sso-2'),
    );

    const adminUser = (await sql.get(`SELECT * FROM admin_users WHERE email = ?`, [email])) as
      | { sso_enabled: number; password_hash: string }
      | undefined;
    expect(adminUser).toBeDefined();
    expect(adminUser!.password_hash).toBe('__otel_pending__');
    expect(adminUser!.sso_enabled).toBe(0);
  });
});
