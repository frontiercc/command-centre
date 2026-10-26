// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// OTel identity conflicts. Runs the real
// lib/db/migrations-pg in a postgres:16 testcontainer.
//
// Claude's OTel user.id is an installation id: a second Claude account on the
// same machine sends the same user.id with a different email. The receivers
// used to insert that person under the taken id, hit the primary key and fail
// the whole request with 500 (reproduced on localhost). Now: never
// fail, keep the second email as its own person, record the clash, and let an
// admin merge / keep separate, going forward only.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

type Rows = Array<Record<string, unknown>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let cleanup: () => Promise<void>;
let sqlTag: typeof import('drizzle-orm').sql;
let cowork: typeof import('@/lib/otel/cowork-receiver');
let code: typeof import('@/lib/otel/code-receiver');
let metrics: typeof import('@/lib/otel/code-metrics-receiver');
let resolver: typeof import('@/lib/otel/resolve-user');
let conflicts: typeof import('@/lib/otel/identity-conflicts');
let queries: typeof import('@/lib/db/queries');

const INSTALL = 'a'.repeat(64);
const A = 'first@example.com';
const B = 'second@example.com';
let seq = 0;

type Attrs = Record<string, string>;
const attrList = (a: Attrs) => Object.entries(a).map(([key, v]) => ({ key, value: { stringValue: v } }));

function resource(service: 'cowork' | 'claude-code', email: string, installationId: string) {
  seq += 1;
  return {
    resource: { attributes: attrList({ 'service.name': service }) },
    scopeLogs: [{
      logRecords: [{
        timeUnixNano: `${1_790_000_000 + seq}000000000`,
        attributes: attrList({
          'event.name': 'user_prompt', 'user.email': email, 'user.id': installationId,
          'session.id': `sess-${service}-${seq}`, 'prompt.id': `prompt-${seq}`,
          prompt: `hello ${seq}`, prompt_length: '7',
        }),
      }],
    }],
  };
}
const logs = (...resourceLogs: unknown[]) => ({ resourceLogs });

async function q(text: string, ...params: unknown[]): Promise<Rows> {
  // Build a parameterised statement: $1.. placeholders filled from params.
  const parts = text.split(/\$\d+/);
  let stmt = sqlTag.raw(parts[0]);
  for (let i = 1; i < parts.length; i++) stmt = sqlTag`${stmt}${params[i - 1]}${sqlTag.raw(parts[i])}`;
  const r = await db.execute(stmt);
  return (r.rows ?? r) as Rows;
}
const n = async (text: string, ...params: unknown[]) => Number((await q(text, ...params))[0].n);

describe('OTel identity conflicts (postgres)', () => {
  beforeAll(async () => {
    const { createTestDbClient } = await import('./helpers/db');
    const t = await createTestDbClient('postgres');
    db = t.client; cleanup = t.cleanup;
    // Dynamic imports AFTER the DATABASE_URL env + module reset (harness rule).
    sqlTag = (await import('drizzle-orm')).sql;
    cowork = await import('@/lib/otel/cowork-receiver');
    code = await import('@/lib/otel/code-receiver');
    metrics = await import('@/lib/otel/code-metrics-receiver');
    resolver = await import('@/lib/otel/resolve-user');
    conflicts = await import('@/lib/otel/identity-conflicts');
    queries = await import('@/lib/db/queries');
  }, 180_000);
  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(async () => {
    for (const t of ['pulse_classifications', 'pulse_events', 'pulse_skill_runs', 'cowork_messages', 'code_assistant_meta',
      'code_otel_metrics', 'cowork_session_stats', 'cowork_sessions', 'alerts', 'otel_identity_aliases', 'otel_identity_conflicts']) {
      await q(`DELETE FROM ${t}`);
    }
    await q(`DELETE FROM admin_users WHERE password_hash = '__otel_pending__' OR email LIKE '%@example.com'`);
    await q(`DELETE FROM users WHERE email LIKE '%@example.com'`);
  });

  const usersByEmail = (e: string) => q(`SELECT id, email FROM users WHERE lower(email) = lower($1)`, e);
  const openConflicts = () => q(`SELECT * FROM otel_identity_conflicts WHERE status = 'open'`);
  const msgsFor = (userId: string) => n(`SELECT COUNT(*) AS n FROM cowork_messages WHERE user_id = $1`, userId);

  describe('second Claude account on the same installation', () => {
    it('Cowork: no failure, a separate person under the email-derived id, one open conflict and a medium alert', async () => {
      const r1 = await cowork.processOtlpLogs(logs(resource('cowork', A, INSTALL)));
      const r2 = await cowork.processOtlpLogs(logs(resource('cowork', B, INSTALL)));
      expect(r1.errors).toEqual([]);
      expect(r2.errors).toEqual([]);
      expect(r2.logsInserted).toBe(1);

      expect((await usersByEmail(A))[0].id).toBe(INSTALL);
      expect((await usersByEmail(B))[0].id).toBe(resolver.derivedUserId(B));

      const open = await openConflicts();
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ installation_id: INSTALL, existing_user_id: INSTALL, new_email: B, surface: 'cowork' });

      const alert = (await q(`SELECT severity, user_id FROM alerts WHERE alert_type = 'identity_conflict'`))[0];
      expect(alert).toMatchObject({ severity: 'medium', user_id: resolver.derivedUserId(B) });
      expect(await msgsFor(resolver.derivedUserId(B))).toBe(1);
    });

    it('Code: the same clash no longer fails the request', async () => {
      await code.processCodeOtlpLogs(logs(resource('claude-code', A, INSTALL)));
      const r = await code.processCodeOtlpLogs(logs(resource('claude-code', B, INSTALL)));
      expect(r.errors).toEqual([]);
      expect((await usersByEmail(B))[0].id).toBe(resolver.derivedUserId(B));
      expect(await openConflicts()).toHaveLength(1);
    });

    it('keeps counting events on the open conflict while it waits for a decision', async () => {
      await cowork.processOtlpLogs(logs(resource('cowork', A, INSTALL)));
      await cowork.processOtlpLogs(logs(resource('cowork', B, INSTALL)));
      await cowork.processOtlpLogs(logs(resource('cowork', B, INSTALL)));
      expect(Number((await openConflicts())[0].event_count)).toBe(2);
    });

    it('one clashing resource never costs the other resources in the same request', async () => {
      await cowork.processOtlpLogs(logs(resource('cowork', A, INSTALL)));
      const r = await cowork.processOtlpLogs(logs(resource('cowork', B, INSTALL), resource('cowork', 'third@example.com', 'c'.repeat(64))));
      expect(r.errors).toEqual([]);
      expect(r.logsInserted).toBe(2);
    });
  });

  describe('other triggers through the same code', () => {
    it('admin_users already holds the installation id under another email', async () => {
      await q(`INSERT INTO admin_users (id, email, password_hash, role) VALUES ($1, 'admin@example.com', 'x', 'admin')`, INSTALL);
      const r = await cowork.processOtlpLogs(logs(resource('cowork', A, INSTALL)));
      expect(r.errors).toEqual([]);
      expect((await usersByEmail(A))[0].id).toBe(resolver.derivedUserId(A));
    });

    it('two requests for the same new person at once give one user and no error', async () => {
      const [r1, r2] = await Promise.all([
        cowork.processOtlpLogs(logs(resource('cowork', A, INSTALL))),
        cowork.processOtlpLogs(logs(resource('cowork', A, INSTALL))),
      ]);
      expect([...r1.errors, ...r2.errors]).toEqual([]);
      expect(await usersByEmail(A)).toHaveLength(1);
    });

    it('an email in different capitals resolves to the existing person', async () => {
      await cowork.processOtlpLogs(logs(resource('cowork', A, INSTALL)));
      const r = await cowork.processOtlpLogs(logs(resource('cowork', 'First@Example.com', INSTALL)));
      expect(r.errors).toEqual([]);
      expect(await usersByEmail(A)).toHaveLength(1);
      expect(await openConflicts()).toHaveLength(0);
    });

    it('the email-derived id is stable and case-insensitive', () => {
      expect(resolver.derivedUserId(B)).toBe(resolver.derivedUserId('  Second@Example.COM '));
      expect(resolver.derivedUserId(B)).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('metrics', () => {
    it("a second account's metrics land on its own id, not the first person's", async () => {
      await code.processCodeOtlpLogs(logs(resource('claude-code', A, INSTALL)));
      await metrics.processCodeOtlpMetrics({
        resourceMetrics: [{
          resource: { attributes: attrList({ 'service.name': 'claude-code' }) },
          scopeMetrics: [{ metrics: [{ name: 'claude_code.lines_of_code.count', sum: { dataPoints: [{
            asDouble: 5, timeUnixNano: '1790000999000000000',
            attributes: attrList({ 'user.email': B, 'user.id': INSTALL, 'session.id': 'sess-metric', type: 'added' }),
          }] } }] }],
        }],
      });
      const row = (await q(`SELECT user_id FROM code_otel_metrics WHERE session_id = 'sess-metric'`))[0];
      expect(row.user_id).toBe(resolver.derivedUserId(B));
    });
  });

  describe('admin decisions — going forward only', () => {
    async function setup() {
      await cowork.processOtlpLogs(logs(resource('cowork', A, INSTALL)));
      await cowork.processOtlpLogs(logs(resource('cowork', B, INSTALL)));
      return String((await openConflicts())[0].id);
    }

    it('merge sends later events to the existing person; undo sends them back; history never moves', async () => {
      const id = await setup();
      const bId = resolver.derivedUserId(B);
      expect(await conflicts.decideIdentityConflict(id, 'merge', 'admin@example.com')).toBe('merged');

      await cowork.processOtlpLogs(logs(resource('cowork', B, INSTALL)));
      expect(await msgsFor(INSTALL)).toBe(2); // A's first + B's post-merge
      expect(await msgsFor(bId)).toBe(1);     // B's pre-merge event stays where it was

      expect(await conflicts.decideIdentityConflict(id, 'undo', 'admin@example.com')).toBe('open');
      await cowork.processOtlpLogs(logs(resource('cowork', B, INSTALL)));
      expect(await msgsFor(bId)).toBe(2);
      expect(await msgsFor(INSTALL)).toBe(2);
      expect(await n(`SELECT COUNT(*) AS n FROM otel_identity_aliases`)).toBe(0);
    });

    it('keep separate changes nothing and can be undone; a decided conflict cannot be merged', async () => {
      const id = await setup();
      expect(await conflicts.decideIdentityConflict(id, 'separate', 'admin@example.com')).toBe('separate');
      await expect(conflicts.decideIdentityConflict(id, 'merge', 'admin@example.com')).rejects.toThrow(/separate/);
      expect(await conflicts.decideIdentityConflict(id, 'undo', 'admin@example.com')).toBe('open');
      await expect(conflicts.decideIdentityConflict(id, 'undo', 'admin@example.com')).rejects.toThrow(/nothing to undo/);
    });

    it('lists conflicts with the existing person resolved', async () => {
      await setup();
      const list = await conflicts.listIdentityConflicts();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ existingEmail: A, newEmail: B, status: 'open', eventCount: 1 });
    });
  });

  describe('GDPR erasure', () => {
    it('deleteUserData removes the conflict and alias rows naming the person', async () => {
      await cowork.processOtlpLogs(logs(resource('cowork', A, INSTALL)));
      await cowork.processOtlpLogs(logs(resource('cowork', B, INSTALL)));
      const id = String((await openConflicts())[0].id);
      await conflicts.decideIdentityConflict(id, 'merge', 'admin@example.com');

      await queries.deleteUserData(resolver.derivedUserId(B));
      expect(await n(`SELECT COUNT(*) AS n FROM otel_identity_conflicts`)).toBe(0);
      expect(await n(`SELECT COUNT(*) AS n FROM otel_identity_aliases`)).toBe(0);
    });
  });
});
