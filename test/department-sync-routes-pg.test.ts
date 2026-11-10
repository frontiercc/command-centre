// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The department sync admin routes, and the two manual-edit routes marking a
// department set by hand. Postgres; the admin session is mocked.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

const mockSession: { authenticated: boolean; role?: string; email?: string; userId?: string } = {
  authenticated: true, role: 'admin', email: 'admin@test.com', userId: 'admin1',
};

vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return {
    ...actual,
    getAdminSession: async () => mockSession,
    requireAdmin: async () => (mockSession.authenticated && mockSession.role === 'admin' ? mockSession : null),
  };
});

let sql: TestSql;
let cleanup: () => Promise<void>;
const NOW = Math.floor(Date.now() / 1000);

function req(url: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
});
afterAll(async () => cleanup());

beforeEach(async () => {
  mockSession.role = 'admin';
  await sql.exec(`DELETE FROM department_history; DELETE FROM admin_users; DELETE FROM users; DELETE FROM config;`);
  await sql.run(`INSERT INTO users (id, email, display_name, source, department, first_seen_at, last_seen_at) VALUES ('u1', 'p1@example.com', 'Person One', 'otel', 'Ops', ?, ?)`, [NOW, NOW]);
  await sql.run(`INSERT INTO admin_users (id, email, password_hash, role, department, linked_cowork_user_id) VALUES ('a1', 'p1@example.com', 'x', 'pulse', 'Ops', 'u1')`);
});

describe('GET /api/admin/department-sync', () => {
  it('is admin only', async () => {
    mockSession.role = 'manager';
    const { GET } = await import('../app/api/admin/department-sync/route');
    expect((await GET(req('/api/admin/department-sync'))).status).toBe(403);
  });

  it('reports no provider until single sign-on is set up, and Entra once it is', async () => {
    const { GET } = await import('../app/api/admin/department-sync/route');
    expect((await (await GET(req('/api/admin/department-sync'))).json()).provider).toEqual({ kind: 'none' });

    const { saveConfig } = await import('@/lib/config');
    await saveConfig({ ssoIssuerUrl: 'https://login.microsoftonline.com/t1/v2.0', ssoClientId: 'c', ssoClientSecret: 's' });
    const body = await (await GET(req('/api/admin/department-sync'))).json();
    expect(body.provider).toEqual({ kind: 'entra', label: 'Microsoft Entra ID' });
    expect(body).toMatchObject({ enabled: false, appliedAt: null, active: false, manualPeople: [] });
  });

  it('says another provider is not supported', async () => {
    const { saveConfig } = await import('@/lib/config');
    await saveConfig({ ssoIssuerUrl: 'https://accounts.google.com', ssoClientId: 'c', ssoClientSecret: 's', ssoProviderLabel: 'Google' });
    const { GET } = await import('../app/api/admin/department-sync/route');
    expect((await (await GET(req('/api/admin/department-sync'))).json()).provider).toEqual({ kind: 'unsupported', label: 'Google' });
  });
});

describe('POST /api/admin/department-sync', () => {
  it('refuses a preview until department sync is switched on', async () => {
    const { POST } = await import('../app/api/admin/department-sync/route');
    expect((await POST(req('/api/admin/department-sync', 'POST', { action: 'preview' }))).status).toBe(409);
  });

  it('refuses Run now before the preview is applied', async () => {
    const { saveConfig } = await import('@/lib/config');
    await saveConfig({ ssoIssuerUrl: 'https://login.microsoftonline.com/t1/v2.0', ssoClientId: 'c', ssoClientSecret: 's', departmentSyncEnabled: 'true' });
    const { POST } = await import('../app/api/admin/department-sync/route');
    expect((await POST(req('/api/admin/department-sync', 'POST', { action: 'run' }))).status).toBe(409);
  });

  it('Return to directory clears a manual department on both records', async () => {
    await sql.exec(`UPDATE users SET department_source = 'manual'; UPDATE admin_users SET department_source = 'manual';`);
    const { POST } = await import('../app/api/admin/department-sync/route');
    expect((await POST(req('/api/admin/department-sync', 'POST', { action: 'return', kind: 'user', id: 'u1' }))).status).toBe(200);
    expect(await sql.get(`SELECT department_source FROM users WHERE id = 'u1'`)).toEqual({ department_source: null });
    expect(await sql.get(`SELECT department_source FROM admin_users WHERE id = 'a1'`)).toEqual({ department_source: null });
  });

  it('is admin only', async () => {
    mockSession.role = 'viewer';
    const { POST } = await import('../app/api/admin/department-sync/route');
    expect((await POST(req('/api/admin/department-sync', 'POST', { action: 'return', kind: 'user', id: 'u1' }))).status).toBe(403);
  });
});

describe('manual edits mark the department', () => {
  it('the person page: a real change is marked manual and recorded; saving the same department is not', async () => {
    const { PUT } = await import('../app/api/users/route');
    await PUT(req('/api/users', 'PUT', { id: 'u1', display_name: 'Renamed', department: 'Ops' }));
    expect(await sql.get(`SELECT department_source FROM users WHERE id = 'u1'`)).toEqual({ department_source: null });

    await PUT(req('/api/users', 'PUT', { id: 'u1', display_name: 'Renamed', department: 'Sales' }));
    expect(await sql.get(`SELECT department, department_source FROM users WHERE id = 'u1'`)).toEqual({ department: 'Sales', department_source: 'manual' });
    expect(await sql.get(`SELECT user_id, from_department, to_department, source FROM department_history`))
      .toEqual({ user_id: 'u1', from_department: 'Ops', to_department: 'Sales', source: 'manual' });
  });

  it('the accounts table: a real change marks both records manual', async () => {
    const { PATCH } = await import('../app/api/admin/users/[id]/route');
    await PATCH(req('/api/admin/users/a1', 'PATCH', { department: 'Finance' }), { params: Promise.resolve({ id: 'a1' }) });
    expect(await sql.get(`SELECT department, department_source FROM admin_users WHERE id = 'a1'`)).toEqual({ department: 'Finance', department_source: 'manual' });
    expect(await sql.get(`SELECT department, department_source FROM users WHERE id = 'u1'`)).toEqual({ department: 'Finance', department_source: 'manual' });
  });
});

describe('GET /api/admin/department-sync/person', () => {
  it("returns the person's source and department changes", async () => {
    await sql.run(`UPDATE users SET department_source = 'directory', department_synced_at = ? WHERE id = 'u1'`, [NOW]);
    await sql.run(`INSERT INTO department_history (id, user_id, from_department, to_department, source, is_move, changed_at) VALUES ('h1', 'u1', NULL, 'Ops', 'directory', 0, ?)`, [NOW]);
    const { GET } = await import('../app/api/admin/department-sync/person/route');
    const body = await (await GET(req('/api/admin/department-sync/person?userId=u1'))).json();
    expect(body).toMatchObject({ syncActive: false, source: 'directory', syncedAt: NOW });
    expect(body.history).toEqual([{ from: null, to: 'Ops', source: 'directory', changedAt: NOW }]);
  });
});
