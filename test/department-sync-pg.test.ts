// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Department sync end to end on Postgres, with a stand-in for Microsoft Graph.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
let sync: typeof import('@/lib/directory/department-sync');
let saveConfig: typeof import('@/lib/config').saveConfig;

const NOW = Math.floor(Date.now() / 1000);
const TENANT = '11111111-2222-3333-4444-555555555555';

/** A stand-in for Microsoft: the token endpoint, the user listing and /me. */
function fakeGraph(opts: { users?: Array<Record<string, unknown>>; me?: Record<string, unknown>; listStatus?: number; fail?: boolean }): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    if (opts.fail) throw new Error('network down');
    const url = String(input);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('/oauth2/v2.0/token')) return json(200, { access_token: 'app-token' });
    if (url.includes('/v1.0/users')) return opts.listStatus ? json(opts.listStatus, {}) : json(200, { value: opts.users ?? [] });
    if (url.includes('/v1.0/me')) return json(200, opts.me ?? {});
    return json(404, {});
  }) as typeof fetch;
}

const DIRECTORY = [
  { mail: 'lee@example.com', department: 'engineering ' },
  // Declan's email in the directory differs from his sign-in; the proxy address matches.
  { mail: 'declan@other.example.com', userPrincipalName: 'dg@example.onmicrosoft.com', proxyAddresses: ['smtp:declan@example.com'], department: 'Operations' },
  { mail: 'mani@example.com', department: 'Finance' },
  { mail: 'empty@example.com', department: '' },
  { mail: 'other@example.com', department: 'Engineering' },
];

async function seed() {
  await sql.exec(`DELETE FROM department_history; DELETE FROM admin_users; DELETE FROM users; DELETE FROM error_events;`);
  const user = (id: string, email: string, dept: string | null, source: string | null = null) => sql.run(
    `INSERT INTO users (id, email, display_name, source, department, department_source, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'otel', ?, ?, ?, ?)`,
    [id, email, id, dept, source, NOW, NOW]);
  await user('u-lee', 'lee@example.com', null);
  await user('u-dec', 'declan@example.com', 'Ops');
  await user('u-mani', 'mani@example.com', 'Legal', 'manual');
  await user('u-ghost', 'ghost@example.com', 'Sales');
  await user('u-empty', 'empty@example.com', 'HR');
  await user('u-other', 'other@example.com', 'Engineering');
  const admin = (id: string, email: string, role: string, dept: string | null, linked: string | null, source: string | null = null) => sql.run(
    `INSERT INTO admin_users (id, email, password_hash, role, department, linked_cowork_user_id, sso_enabled, department_source) VALUES (?, ?, 'x', ?, ?, ?, 1, ?)`,
    [id, email, role, dept, linked, source]);
  await admin('a-lee', 'lee@example.com', 'admin', null, 'u-lee');
  await admin('a-dec', 'declan@example.com', 'pulse', 'Ops', null);
  await admin('a-mani', 'mani@example.com', 'viewer', 'Legal', 'u-mani', 'manual');
  await saveConfig({
    ssoIssuerUrl: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    ssoClientId: 'client-id',
    ssoClientSecret: 'client-secret',
    departmentSyncEnabled: 'true',
    departmentSyncAppliedAt: String(NOW),
    departmentSyncMap: '{}',
    departmentSyncLastStats: '',
    departmentSyncLastRun: '',
  });
}

async function dept(table: 'users' | 'admin_users', id: string) {
  return sql.get<{ department: string | null; department_source: string | null; role?: string; sso_enabled?: number }>(
    `SELECT * FROM ${table} WHERE id = ?`, [id]);
}

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
  sync = await import('@/lib/directory/department-sync');
  saveConfig = (await import('@/lib/config')).saveConfig;
});

afterAll(async () => cleanup());
beforeEach(seed);

describe('daily lookup', () => {
  it('applies the rules to everyone, writing login accounts and monitored people together', async () => {
    const stats = await sync.runDepartmentSync('run_now', fakeGraph({ users: DIRECTORY }));

    // Blank filled, matched to the existing spelling regardless of capitals and spacing.
    expect((await dept('users', 'u-lee'))?.department).toBe('Engineering');
    expect((await dept('admin_users', 'a-lee'))).toMatchObject({ department: 'Engineering', department_source: 'directory' });
    // Matched on a proxy address; both records updated; a new department.
    expect((await dept('users', 'u-dec'))).toMatchObject({ department: 'Operations', department_source: 'directory' });
    expect((await dept('admin_users', 'a-dec'))?.department).toBe('Operations');
    // Manual kept; empty directory value changes nothing; not found left alone.
    expect((await dept('users', 'u-mani'))).toMatchObject({ department: 'Legal', department_source: 'manual' });
    expect((await dept('users', 'u-empty'))?.department).toBe('HR');
    expect((await dept('users', 'u-ghost'))?.department).toBe('Sales');

    expect(stats).toMatchObject({ people: 6, inDirectory: 5, updated: 2, unchanged: 1, manual: 1, emptyInDirectory: 1, notFound: 1, notFoundIds: ['u-ghost'] });
    expect(stats.newNames).toEqual(['Operations']);
    expect(stats.names.find(n => n.directoryName === 'engineering')).toMatchObject({ department: 'Engineering', matchedBy: 'existing', people: 2 });
  });

  it('never changes a role or single sign-on access', async () => {
    await sync.runDepartmentSync('run_now', fakeGraph({ users: DIRECTORY }));
    expect(await dept('admin_users', 'a-dec')).toMatchObject({ role: 'pulse', sso_enabled: 1 });
    expect(await dept('admin_users', 'a-lee')).toMatchObject({ role: 'admin', sso_enabled: 1 });
  });

  it('records each change; the first directory department is not a move, a later change is', async () => {
    await sync.runDepartmentSync('run_now', fakeGraph({ users: DIRECTORY }));
    const first = await sql.all<{ user_id: string; from_department: string | null; to_department: string; is_move: number; source: string }>(
      `SELECT user_id, from_department, to_department, is_move, source FROM department_history ORDER BY user_id`);
    expect(first).toEqual([
      { user_id: 'u-dec', from_department: 'Ops', to_department: 'Operations', is_move: 0, source: 'directory' },
      { user_id: 'u-lee', from_department: null, to_department: 'Engineering', is_move: 0, source: 'directory' },
    ]);

    const moved = DIRECTORY.map(u => (u.mail === 'declan@other.example.com' ? { ...u, department: 'Finance' } : u));
    await sync.runDepartmentSync('run_now', fakeGraph({ users: moved }));
    const move = await sql.get<{ from_department: string; to_department: string; is_move: number }>(
      `SELECT from_department, to_department, is_move FROM department_history WHERE user_id = 'u-dec' ORDER BY changed_at DESC, is_move DESC LIMIT 1`);
    expect(move).toEqual({ from_department: 'Operations', to_department: 'Finance', is_move: 1 });
  });

  it("lists a new name as new even when a kept-manual person carrying it is read first", async () => {
    // Mani (manual, read first as a login account) and the monitored-only
    // person below both have Finance in the directory; Finance is new.
    await sql.run(`INSERT INTO users (id, email, display_name, source, first_seen_at, last_seen_at) VALUES ('u-fin', 'fin@example.com', 'u-fin', 'otel', ?, ?)`, [NOW, NOW]);
    const stats = await sync.runDepartmentSync('run_now', fakeGraph({ users: [...DIRECTORY, { mail: 'fin@example.com', department: 'Finance' }] }));
    expect(stats.names.find(n => n.directoryName === 'Finance')).toMatchObject({ matchedBy: 'new', people: 1 });
    expect(stats.newNames).toEqual(['Finance', 'Operations']);
  });

  it('uses the name map', async () => {
    await saveConfig({ departmentSyncMap: JSON.stringify({ operations: 'Ops' }) });
    const stats = await sync.runDepartmentSync('run_now', fakeGraph({ users: DIRECTORY }));
    expect((await dept('users', 'u-dec'))?.department).toBe('Ops');
    expect(stats.newNames).toEqual([]);
  });

  it('treats a missing User.Read.All as a note, not a failure, and changes nothing', async () => {
    const stats = await sync.runDepartmentSync('daily', fakeGraph({ listStatus: 403 }));
    expect(stats.error?.kind).toBe('permission');
    expect((await dept('users', 'u-dec'))?.department).toBe('Ops');
  });

  it('throws on any other failure, with fixed text in the stats and the detail recorded', async () => {
    await expect(sync.runDepartmentSync('run_now', fakeGraph({ fail: true }))).rejects.toThrow();
    const stats = JSON.parse((await sql.get<{ value: string }>(`SELECT value FROM config WHERE key = 'department_sync_last_stats'`))!.value);
    expect(stats.error).toEqual({ kind: 'failed', message: "Couldn't reach Microsoft Entra ID. The detail is in System health." });
    expect(await sql.get(`SELECT 1 FROM error_events WHERE source = 'department-sync'`)).toBeTruthy();
    expect((await dept('users', 'u-dec'))?.department).toBe('Ops');
  });
});

describe('preview', () => {
  it('reports what would happen and writes nothing', async () => {
    const stats = await sync.previewDepartmentSync(fakeGraph({ users: DIRECTORY }));
    expect(stats).toMatchObject({ updated: 2, notFound: 1 });
    expect((await dept('users', 'u-lee'))?.department).toBeNull();
    expect(await sql.get(`SELECT 1 FROM department_history`)).toBeUndefined();
  });
});

describe('sign-in', () => {
  it("updates only the person who signed in, from their own directory entry", async () => {
    await sync.syncDepartmentAtSignIn('lee@example.com', 'user-token', fakeGraph({ me: { mail: 'lee@example.com', department: 'Data' } }));
    expect((await dept('admin_users', 'a-lee'))?.department).toBe('Data');
    expect((await dept('users', 'u-lee'))?.department).toBe('Data');
    expect((await dept('users', 'u-dec'))?.department).toBe('Ops');
  });

  it('does nothing until the first-run preview has been applied', async () => {
    await saveConfig({ departmentSyncAppliedAt: '' });
    await sync.syncDepartmentAtSignIn('lee@example.com', 'user-token', fakeGraph({ me: { mail: 'lee@example.com', department: 'Data' } }));
    expect((await dept('admin_users', 'a-lee'))?.department).toBeNull();
  });

  it('never throws: a failure keeps the department and is recorded', async () => {
    await expect(sync.syncDepartmentAtSignIn('declan@example.com', 'user-token', fakeGraph({ fail: true }))).resolves.toBeUndefined();
    expect((await dept('admin_users', 'a-dec'))?.department).toBe('Ops');
    expect(await sql.get(`SELECT 1 FROM error_events WHERE source = 'department-sync'`)).toBeTruthy();
  });

  it('keeps a department set by hand', async () => {
    await sync.syncDepartmentAtSignIn('mani@example.com', 'user-token', fakeGraph({ me: { mail: 'mani@example.com', department: 'Finance' } }));
    expect((await dept('admin_users', 'a-mani'))?.department).toBe('Legal');
  });
});

describe('manual departments', () => {
  it('marks a department set by hand and records the change; Return to directory hands it back', async () => {
    await sync.recordManualDepartment({ adminUserId: 'a-dec', userIds: ['u-dec'], from: 'Ops', to: 'Sales' });
    expect((await dept('admin_users', 'a-dec'))?.department_source).toBe('manual');
    expect(await sql.get(`SELECT source, from_department, to_department FROM department_history WHERE admin_user_id = 'a-dec'`))
      .toEqual({ source: 'manual', from_department: 'Ops', to_department: 'Sales' });

    await sync.runDepartmentSync('run_now', fakeGraph({ users: DIRECTORY }));
    expect((await dept('users', 'u-dec'))?.department).toBe('Ops'); // untouched: manual

    await sync.returnToDirectory({ adminUserId: 'a-dec', userIds: ['u-dec'] });
    await sync.runDepartmentSync('run_now', fakeGraph({ users: DIRECTORY }));
    expect((await dept('users', 'u-dec'))?.department).toBe('Operations');
  });
});
