// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Proof that logAccess() writes through getAuditClient()
// (lib/db/client.ts) on Postgres, NOT the old file-backed getAuditDb(). This
// is the test that proves the Postgres append-only immutability is
// actually LIVE via the logAccess path:
//
//   1. logAccess(entry) writes a row to access_audit_log retrievable via
//      getAuditClient().
//   2. The row is IMMUTABLE — UPDATE/DELETE are rejected by the append-only
//      triggers getAuditClient() installs on the fresh pool. This is the
//      whole point: logAccess now writes through the immutable path.
//   3. logAccess NEVER throws/rejects even when the write fails (invalid
//      action → CHECK violation) — the API-safety contract.
//
// HARNESS RULE (mirrors error-queries.test.ts / audit-immutability-pg.test.ts):
// lib/audit/log.ts reaches the database through getAuditClient(), which binds
// to DATABASE_URL on first use, so the module-under-test is
// DYNAMIC-imported AFTER createTestDbClient() has set DATABASE_URL +
// vi.resetModules(). The audit client has its own process singleton
// (__ccc_audit_client); createTestDbClient()'s cleanup clears it.
import { describe, it, expect } from 'vitest';
import type { AccessLogEntry } from '@/lib/audit/log';

const ENTRY: AccessLogEntry = {
  actorId: 'admin-1',
  actorEmail: 'alice@example.com',
  actorIp: '10.0.0.1',
  resource: 'events',
  action: 'READ',
  outcome: 'success',
  detail: 'q=foo',
};

interface AuditRow {
  actor_id: string;
  actor_email: string;
  actor_ip: string | null;
  resource: string;
  action: string;
  outcome: string;
  detail: string | null;
}

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const { cleanup } = await createTestDbClient('postgres');
  try {
    // Dynamic import AFTER the DATABASE_URL env + module reset (harness rule).
    const { getAuditClient } = await import('@/lib/db/client');
    const { logAccess } = await import('@/lib/audit/log');

    // Establish the audit-client singleton. getAuditClient() bootstraps the
    // table + append-only triggers (applyAuditImmutabilityPg) on its fresh
    // pool; the test deliberately does NOT create them itself.
    const auditClient = await getAuditClient();
    const raw = (auditClient as unknown as {
      $client: { query: (sql: string) => Promise<{ rows: unknown[] }> };
    }).$client;

    const queryAll = async (): Promise<AuditRow[]> =>
      (await raw.query('SELECT * FROM access_audit_log ORDER BY id')).rows as AuditRow[];

    // ── (1) logAccess writes a row retrievable via getAuditClient ───────────
    await logAccess(ENTRY);

    const rows = await queryAll();
    expect(rows.length).toBe(1);
    expect(rows[0].actor_id).toBe('admin-1');
    expect(rows[0].actor_email).toBe('alice@example.com');
    expect(rows[0].actor_ip).toBe('10.0.0.1');
    expect(rows[0].resource).toBe('events');
    expect(rows[0].action).toBe('READ');
    expect(rows[0].outcome).toBe('success');
    expect(rows[0].detail).toBe('q=foo');

    // actor_ip defaults to null when omitted (exact column mapping preserved).
    await logAccess({
      actorId: 'u2',
      actorEmail: 'bob@example.com',
      resource: 'alerts',
      action: 'READ',
      outcome: 'success',
    });
    const rows2 = await queryAll();
    expect(rows2.length).toBe(2);
    expect(rows2[1].actor_ip).toBeNull();
    expect(rows2[1].detail).toBeNull();

    // SSO_LOGIN / failure (OIDC SSO) pass the audit CHECK and are recorded —
    // Postgres creates the table with the wide CHECK.
    await logAccess({
      actorId: 'sso-user',
      actorEmail: 'sso@example.com',
      resource: 'auth/sso',
      action: 'SSO_LOGIN',
      outcome: 'failure',
      detail: 'idp rejected',
    });
    const rows3 = await queryAll();
    expect(rows3.length).toBe(3);
    expect(rows3[2].action).toBe('SSO_LOGIN');
    expect(rows3[2].outcome).toBe('failure');

    // ── (2) immutability holds through the logAccess path ───────────────────
    await expect(
      raw.query(`UPDATE access_audit_log SET outcome = 'denied' WHERE actor_id = 'admin-1'`),
    ).rejects.toThrow(/append-only/);
    await expect(
      raw.query(`DELETE FROM access_audit_log WHERE actor_id = 'admin-1'`),
    ).rejects.toThrow(/append-only/);
    // Rows survived the rejected mutations unchanged.
    const after = await queryAll();
    expect(after.length).toBe(3);
    expect(after[0].outcome).toBe('success');

    // ── (3) logAccess NEVER rejects, even when the write fails ──────────────
    // An invalid action violates the CHECK constraint; the
    // rejected write must be swallowed inside logAccess (await inside try/catch).
    await expect(
      logAccess({
        actorId: 'u3',
        actorEmail: 'carol@example.com',
        resource: 'events',
        action: 'HACK' as AccessLogEntry['action'],
        outcome: 'success',
      }),
    ).resolves.toBeUndefined();
    // The failed write added nothing.
    expect((await queryAll()).length).toBe(3);
  } finally {
    await cleanup();
  }
}

describe('logAccess writes through getAuditClient', () => {
  it(
    'writes a row to the Postgres audit log, immutability rejects UPDATE/DELETE, never throws',
    async () => {
      await runSpec();
    },
    180_000,
  );
});
