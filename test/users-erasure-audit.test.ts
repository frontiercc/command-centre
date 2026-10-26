// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The erasure action must land in the formal access-audit log:
// success, denied (non-admin), error, and failure outcomes,
// with the target captured BEFORE the row is deleted.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

vi.mock('@/lib/audit/log', () => ({ logAccess: vi.fn(async () => {}) }));

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string; department?: string | null };
vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return {
    ...actual,
    getAdminSession: vi.fn(() => sessionResult),
  };
});

// I2: deleteUserData can now throw (bounded erasure tolerance, I1) — a
// mutable flag lets one test force that path while the other three keep
// calling through to the real implementation, mirroring the sessionResult
// pattern above rather than resetModules()-ing the route between tests.
let deleteUserDataShouldThrow = false;
vi.mock('@/lib/db/queries', async (orig) => {
  const actual = await orig<typeof import('@/lib/db/queries')>();
  return {
    ...actual,
    deleteUserData: vi.fn(async (userId: string) => {
      if (deleteUserDataShouldThrow) throw new Error('erasure boom');
      return actual.deleteUserData(userId);
    }),
  };
});

let sql: TestSql;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  vi.clearAllMocks();
  sessionResult = { authenticated: true, role: 'admin', userId: 'admin-1', email: 'admin@example.com', department: null };
  deleteUserDataShouldThrow = false;
  await sql.exec(`DELETE FROM users;`);
  const now = Math.floor(Date.now() / 1000);
  await sql.run(
    `INSERT INTO users (id, email, display_name, source, first_seen_at, last_seen_at) VALUES ('u1', 'u1@test.com', 'Ada', 'otel', ?, ?)`,
    [now, now],
  );
});

function makeRequest(url: string, init?: { method?: string }): NextRequest {
  return new NextRequest(`http://localhost${url}`, init);
}

describe('DELETE /api/users (GDPR/LGPD erasure audit trail)', () => {
  it('logs success with the target id and email BEFORE the row is deleted', async () => {
    const { logAccess } = await import('@/lib/audit/log');
    const route = await import('../app/api/users/route');
    const res = await route.DELETE(makeRequest('/api/users?userId=u1', { method: 'DELETE' }));
    expect(res.status).toBe(200);
    expect(logAccess).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(logAccess).mock.calls[0][0];
    expect(entry.resource).toBe('users');
    expect(entry.action).toBe('DELETE');
    expect(entry.outcome).toBe('success');
    expect(entry.detail).toContain('u1');
    expect(entry.detail).toContain('u1@test.com');
  });

  it('403s a manager and logs a denied outcome', async () => {
    sessionResult = { authenticated: true, role: 'manager', userId: 'm1', email: 'm1@test.com', department: null };
    const { logAccess } = await import('@/lib/audit/log');
    const route = await import('../app/api/users/route');
    const res = await route.DELETE(makeRequest('/api/users?userId=u1', { method: 'DELETE' }));
    expect(res.status).toBe(403);
    expect(logAccess).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(logAccess).mock.calls[0][0];
    expect(entry.resource).toBe('users');
    expect(entry.action).toBe('DELETE');
    expect(entry.outcome).toBe('denied');
    // Nothing should have been erased.
    const row = await sql.get(`SELECT id FROM users WHERE id = 'u1'`);
    expect(row).toBeTruthy();
  });

  it('404s an unknown userId and logs an error outcome — nothing erased', async () => {
    const { logAccess } = await import('@/lib/audit/log');
    const route = await import('../app/api/users/route');
    const res = await route.DELETE(makeRequest('/api/users?userId=does-not-exist', { method: 'DELETE' }));
    expect(res.status).toBe(404);
    expect(logAccess).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(logAccess).mock.calls[0][0];
    expect(entry.resource).toBe('users');
    expect(entry.action).toBe('DELETE');
    expect(entry.outcome).toBe('error');
    // The seeded user must be untouched.
    const row = await sql.get(`SELECT id FROM users WHERE id = 'u1'`);
    expect(row).toBeTruthy();
  });

  it('logs a failure outcome and rethrows when deleteUserData throws (I2)', async () => {
    deleteUserDataShouldThrow = true;
    const { logAccess } = await import('@/lib/audit/log');
    const route = await import('../app/api/users/route');
    await expect(
      route.DELETE(makeRequest('/api/users?userId=u1', { method: 'DELETE' })),
    ).rejects.toThrow('erasure boom');
    expect(logAccess).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(logAccess).mock.calls[0][0];
    expect(entry.resource).toBe('users');
    expect(entry.action).toBe('DELETE');
    expect(entry.outcome).toBe('failure');
    expect(entry.detail).toContain('u1');
    expect(entry.detail).toContain('erasure boom');
    // Nothing should have been erased — the seeded user is untouched.
    const row = await sql.get(`SELECT id FROM users WHERE id = 'u1'`);
    expect(row).toBeTruthy();
  });
});
