// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Department scoping: getAlerts({ department }) is the underlying
// filter the route now gates behind isDeptScoped(session.role) — org-wide
// roles (admin/viewer) pass no department by default and see everything;
// dept-scoped roles (cowork/pulse/code) always pass their own. This file
// exercises the query-level filter directly per the task brief.
//
// Display names: getAlerts() now resolves alerts.user_id to a
// user_display_name via the same admin_users-wins-over-users COALESCE join
// as getComplianceEvents, without overwriting user_id itself.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';
import { seedUserSql } from './helpers/seed';

let sql: TestSql;
let cleanup: () => Promise<void>;
let getAlerts: (filters?: { status?: string; department?: string; types?: string[] }) => Promise<any[]>;
let insertAlert: (alert: {
  id: string; user_id: string | null; alert_type: string;
  severity: string; title: string; explanation: string; raw_evidence: string;
}) => Promise<void>;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const queries = await import('@/lib/db/queries');
  getAlerts = queries.getAlerts as typeof getAlerts;
  insertAlert = queries.insertAlert;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec('DELETE FROM alerts');
  await sql.exec('DELETE FROM users');
  await sql.exec('DELETE FROM admin_users');
});

async function insertTestAlert(id: string, userId: string | null) {
  await insertAlert({
    id,
    user_id: userId,
    alert_type: 'anomaly',
    severity: 'medium',
    title: 'Test alert',
    explanation: 'Test explanation',
    raw_evidence: '{}',
  });
}

// ─── Department scoping ─────────────────────────────────────────────

describe('getAlerts department filter', () => {
  it('with no department filter returns all alerts regardless of user department (mixed/NULL depts)', async () => {
    await seedUserSql(sql, 'user-fin');
    await sql.run('UPDATE users SET department = ? WHERE id = ?', ['Finance', 'user-fin']);
    await seedUserSql(sql, 'user-eng');
    await sql.run('UPDATE users SET department = ? WHERE id = ?', ['Engineering', 'user-eng']);
    await seedUserSql(sql, 'user-none'); // department stays NULL

    await insertTestAlert('a-fin', 'user-fin');
    await insertTestAlert('a-eng', 'user-eng');
    await insertTestAlert('a-none', 'user-none');
    await insertTestAlert('a-org', null); // org-level alert, no user_id

    const results = await getAlerts({});
    expect(results.map((r) => r.id).sort()).toEqual(['a-eng', 'a-fin', 'a-none', 'a-org']);
  });

  it('with department=Finance returns only Finance-linked alerts', async () => {
    await seedUserSql(sql, 'user-fin');
    await sql.run('UPDATE users SET department = ? WHERE id = ?', ['Finance', 'user-fin']);
    await seedUserSql(sql, 'user-eng');
    await sql.run('UPDATE users SET department = ? WHERE id = ?', ['Engineering', 'user-eng']);

    await insertTestAlert('a-fin', 'user-fin');
    await insertTestAlert('a-eng', 'user-eng');

    const results = await getAlerts({ department: 'Finance' });
    expect(results.map((r) => r.id)).toEqual(['a-fin']);
  });
});

// ─── Resolved display names ─────────────────────────────────────────

describe('getAlerts user_display_name resolution', () => {
  it('resolves user_id to the linked display name (UUID user, no admin_users row needed)', async () => {
    const uuid = '11111111-1111-1111-1111-111111111111';
    await seedUserSql(sql, uuid);
    await sql.run('UPDATE users SET display_name = ? WHERE id = ?', ['Hugo Lambert', uuid]);
    await insertTestAlert('a-named', uuid);

    const results = await getAlerts({});
    const row = results.find((r) => r.id === 'a-named');
    expect(row).toBeDefined();
    expect(row.user_display_name).toBe('Hugo Lambert');
    // user_id must NOT be overwritten — the raw id stays intact.
    expect(row.user_id).toBe(uuid);
  });

  it('falls back to the email when user_id has no display name on either users or admin_users', async () => {
    // alerts.user_id has a FK to users(id), so a users row always exists; with
    // no display name anywhere, the email is shown rather than the raw id.
    await seedUserSql(sql, 'ghost-user-id');

    await insertTestAlert('a-unmatched', 'ghost-user-id');

    const results = await getAlerts({});
    const row = results.find((r) => r.id === 'a-unmatched');
    expect(row).toBeDefined();
    expect(row.user_display_name).toBe('ghost-user-id@test.local');
    expect(row.user_id).toBe('ghost-user-id');
  });

  it('an admin_users linked display name wins over the plain users display_name', async () => {
    const uuid = '22222222-2222-2222-2222-222222222222';
    await seedUserSql(sql, uuid);
    await sql.run('UPDATE users SET display_name = ? WHERE id = ?', ['Auto Captured Name', uuid]);
    await sql.run(
      `INSERT INTO admin_users (id, email, password_hash, role, display_name, linked_cowork_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['admin-1', 'admin1@test.local', 'x', 'admin', 'Hugo Lambert', uuid],
    );
    await insertTestAlert('a-linked', uuid);

    const results = await getAlerts({});
    const row = results.find((r) => r.id === 'a-linked');
    expect(row?.user_display_name).toBe('Hugo Lambert');
  });
});

// ─── Raw user_id embedded inside title/explanation text ─────────────
//
// Some Developer Pulse generators (code_cost_spike, code_model_policy) interpolate
// the raw alerts.user_id directly into the frozen title/explanation strings
// at creation time. For OTel-derived users whose id is an internal hash
// (not a readable email), that text is unreadable even though a display
// name is resolvable via the display-name join — e.g. "26991652d5eb...ac spent
// $28.28..." instead of "Rui Moreno spent $28.28...". getAlerts() now
// substitutes the resolved display name into title/explanation wherever the
// raw id appears, without touching the stored row.

describe('getAlerts substitutes the resolved display name into title/explanation text', () => {
  it('replaces every occurrence of the raw user_id in explanation with the resolved display name', async () => {
    const uuid = '33333333-3333-3333-3333-333333333333';
    await seedUserSql(sql, uuid);
    await sql.run('UPDATE users SET display_name = ? WHERE id = ?', ['Rui Moreno', uuid]);
    await insertAlert({
      id: 'a-embedded',
      user_id: uuid,
      alert_type: 'code_cost_spike',
      severity: 'medium',
      title: 'Claude Code spend spike: $28.28 in 24h',
      explanation: `${uuid} spent $28.28 on Claude Code in the last 24 hours — trailing daily average is $1.29 (threshold $25.00). Could be a heavy work burst or a runaway loop worth a look.`,
      raw_evidence: '{}',
    });

    const results = await getAlerts({});
    const row = results.find((r) => r.id === 'a-embedded');
    expect(row).toBeDefined();
    expect(row.explanation).toBe(
      'Rui Moreno spent $28.28 on Claude Code in the last 24 hours — trailing daily average is $1.29 (threshold $25.00). Could be a heavy work burst or a runaway loop worth a look.'
    );
    expect(row.explanation).not.toContain(uuid);
    // title has no embedded user_id for this alert type — must be untouched.
    expect(row.title).toBe('Claude Code spend spike: $28.28 in 24h');
  });

  it('uses the email in title/explanation when no display name resolves for the raw id', async () => {
    await seedUserSql(sql, 'ghost-embedded');
    await insertAlert({
      id: 'a-embedded-unresolved',
      user_id: 'ghost-embedded',
      alert_type: 'code_cost_spike',
      severity: 'medium',
      title: 'Claude Code spend spike: $10.00 in 24h',
      explanation: 'ghost-embedded spent $10.00 on Claude Code in the last 24 hours.',
      raw_evidence: '{}',
    });

    const results = await getAlerts({});
    const row = results.find((r) => r.id === 'a-embedded-unresolved');
    expect(row).toBeDefined();
    expect(row.explanation).toBe('ghost-embedded@test.local spent $10.00 on Claude Code in the last 24 hours.');
  });

  it('replaces the raw user_id in title too, when present (e.g. a future generator that embeds it there)', async () => {
    const uuid = '44444444-4444-4444-4444-444444444444';
    await seedUserSql(sql, uuid);
    await sql.run('UPDATE users SET display_name = ? WHERE id = ?', ['Ada Lovelace', uuid]);
    await insertAlert({
      id: 'a-title-embedded',
      user_id: uuid,
      alert_type: 'code_model_policy',
      severity: 'medium',
      title: `Non-approved model used by ${uuid}`,
      explanation: `${uuid} used model "gpt-5", which is not on the approved model list.`,
      raw_evidence: '{}',
    });

    const results = await getAlerts({});
    const row = results.find((r) => r.id === 'a-title-embedded');
    expect(row?.title).toBe('Non-approved model used by Ada Lovelace');
    expect(row?.explanation).toBe('Ada Lovelace used model "gpt-5", which is not on the approved model list.');
  });
});

// The Alerts page prints an alert's evidence as it is, and the evidence keeps
// the raw id (the generators' dedup reads it). getAlerts shows the name there.
describe('getAlerts shows the name, not the raw id, in the evidence', () => {
  const HASH = '3c9e1f0a7b2d4e6f8a1c3e5f7b9d2a4c6e8f0a1b3d5c7e9f1a2b4c6d8e0f1a3b';

  it('replaces "user_id" with "user": <name> and the id inside other values', async () => {
    await seedUserSql(sql, HASH, 'jane.smith@test.local');
    await sql.run('UPDATE users SET display_name = ? WHERE id = ?', ['Jane Smith', HASH]);
    await insertAlert({
      id: 'a-evidence', user_id: HASH, alert_type: 'code_model_policy', severity: 'medium',
      title: 'Non-approved model in Claude Code: gpt-5', explanation: 'Jane Smith used model "gpt-5".',
      raw_evidence: JSON.stringify({ source: 'code_pulse', subject: `${HASH}:gpt-5`, user_id: HASH, model: 'gpt-5' }),
    });

    const row = (await getAlerts({})).find((r) => r.id === 'a-evidence');
    expect(row.raw_evidence).not.toContain(HASH);
    expect(JSON.parse(row.raw_evidence)).toEqual({ source: 'code_pulse', subject: 'Jane Smith:gpt-5', user: 'Jane Smith', model: 'gpt-5' });

    // The stored row keeps the id for dedup.
    const stored = (await sql.get(`SELECT CAST(raw_evidence AS TEXT) AS ev FROM alerts WHERE id = 'a-evidence'`)) as { ev: string };
    expect(stored.ev).toContain(HASH);
  });
});
