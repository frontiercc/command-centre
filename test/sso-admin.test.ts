// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Admin-facing SSO surfaces —
 *   - POST /api/admin/sso-test: admin-only, runs OIDC discovery server-side
 *     against the mock IdP (ok:true + issuer) and against an unreachable
 *     issuer (ok:false + error). Never echoes the client secret back.
 *   - PATCH /api/admin/users/[id]: accepts { sso_enabled } — toggles the flag,
 *     rejects non-admin callers, same conventions as the existing role/password/
 *     department/linkedCoworkUserId fields on this route.
 *   - GET /api/admin/users: payload includes a server-computed `autoEnrolled`
 *     boolean (true for '__otel_pending__' sentinel rows, false otherwise) and
 *     NEVER includes password_hash in any form.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';
import { startMockIdp, type MockIdp } from './helpers/mock-idp';

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string };
vi.mock('@/lib/auth/admin-auth', () => ({
  getAdminSession: vi.fn(() => sessionResult),
  requireAdmin: vi.fn(() => (sessionResult.authenticated && sessionResult.role === 'admin' ? sessionResult : null)),
  hashPassword: vi.fn((pw: string) => `hashed:${pw}`),
}));

vi.mock('@/lib/audit/log', () => ({
  logAccess: vi.fn(),
}));

vi.mock('@/lib/db/auth-events', () => ({
  logAuthEvent: vi.fn(),
}));

let sql: TestSql;
let cleanupDb: () => Promise<void>;
let idp: MockIdp;

let cfg: typeof import('@/lib/config');
let adminQueries: typeof import('@/lib/db/admin-queries');

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanupDb = testDb.cleanup;

  idp = await startMockIdp();

  cfg = await import('@/lib/config');
  adminQueries = await import('@/lib/db/admin-queries');
});

afterAll(async () => {
  await idp.stop();
  await cleanupDb();
});

beforeEach(async () => {
  await sql.exec(`DELETE FROM admin_users WHERE email LIKE '%@sso-admin.test'`);
  sessionResult = { authenticated: true, role: 'admin', userId: 'admin-1', email: 'admin@sso-admin.test' };
});

async function configureSso(overrides: Partial<{ issuer: string; clientId: string; clientSecret: string }> = {}) {
  const { issuer = idp.issuer, clientId = 'test-client', clientSecret = 'test-secret' } = overrides;
  await cfg.setConfigValue('ssoEnabled', 'true');
  await cfg.setConfigValue('ssoIssuerUrl', issuer);
  await cfg.setConfigValue('ssoClientId', clientId);
  await cfg.setConfigValue('ssoClientSecret', clientSecret);
  await cfg.setConfigValue('ssoRedirectBaseUrl', 'http://localhost:3001');
  await cfg.setConfigValue('ssoProviderLabel', 'Mock IdP');
}

// ─── POST /api/admin/sso-test ───────────────────────────────────────────────

describe('POST /api/admin/sso-test', () => {
  function makeRequest(body: unknown = {}) {
    return new NextRequest('http://localhost/api/admin/sso-test', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('401/403s when not authenticated', async () => {
    sessionResult = { authenticated: false };
    const { POST } = await import('../app/api/admin/sso-test/route');
    const res = await POST(makeRequest());
    expect([401, 403]).toContain(res.status);
  });

  it('403s for a non-admin role', async () => {
    sessionResult = { authenticated: true, role: 'viewer', userId: 'v1', email: 'viewer@sso-admin.test' };
    const { POST } = await import('../app/api/admin/sso-test/route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
  });

  it('returns ok:true with the discovered issuer for a reachable mock IdP', async () => {
    await configureSso();
    const { POST } = await import('../app/api/admin/sso-test/route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.issuer).toBe(idp.issuer);
    expect(body.error).toBeUndefined();
  });

  it('returns ok:false with an error for an unreachable issuer', async () => {
    await configureSso({ issuer: 'http://127.0.0.1:1' }); // nothing listens here
    const { POST } = await import('../app/api/admin/sso-test/route');
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
  });

  it('never echoes the client secret back in the response body', async () => {
    await configureSso({ clientSecret: 'super-secret-value-xyz' });
    const { POST } = await import('../app/api/admin/sso-test/route');
    const res = await POST(makeRequest());
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain('super-secret-value-xyz');
  });

  it('accepts an in-flight override so the admin can test before saving', async () => {
    // Saved config points at an unreachable issuer; the request body carries
    // the not-yet-saved (but reachable) issuer under test.
    await configureSso({ issuer: 'http://127.0.0.1:1' });
    const { POST } = await import('../app/api/admin/sso-test/route');
    const res = await POST(makeRequest({ issuerUrl: idp.issuer, clientId: 'test-client', clientSecret: 'test-secret' }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.issuer).toBe(idp.issuer);
  });
});

// ─── PATCH /api/admin/users/[id] — sso_enabled ──────────────────────────────

describe('PATCH /api/admin/users/[id] — sso_enabled', () => {
  function makeRequest(body: unknown) {
    return new NextRequest('http://localhost/api/admin/users/x', {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('toggles sso_enabled to true', async () => {
    const user = await adminQueries.createAdminUser({ email: 'toggle-on@sso-admin.test', passwordHash: '__otel_pending__', role: 'pulse' });
    await sql.run(`UPDATE admin_users SET sso_enabled = 0 WHERE id = ?`, [user.id]);

    const { PATCH } = await import('../app/api/admin/users/[id]/route');
    const res = await PATCH(makeRequest({ sso_enabled: 1 }), { params: Promise.resolve({ id: user.id }) });
    expect(res.status).toBe(200);

    const updated = (await adminQueries.findAdminById(user.id))!;
    expect(updated.sso_enabled).toBe(1);
  });

  it('toggles sso_enabled to false', async () => {
    const user = await adminQueries.createAdminUser({ email: 'toggle-off@sso-admin.test', passwordHash: 'real-hash', role: 'admin' });
    expect((await adminQueries.findAdminById(user.id))!.sso_enabled).toBe(1);

    const { PATCH } = await import('../app/api/admin/users/[id]/route');
    const res = await PATCH(makeRequest({ sso_enabled: 0 }), { params: Promise.resolve({ id: user.id }) });
    expect(res.status).toBe(200);

    const updated = (await adminQueries.findAdminById(user.id))!;
    expect(updated.sso_enabled).toBe(0);
  });

  it('response body never includes password_hash', async () => {
    const user = await adminQueries.createAdminUser({ email: 'safe-shape@sso-admin.test', passwordHash: '__otel_pending__', role: 'pulse' });
    const { PATCH } = await import('../app/api/admin/users/[id]/route');
    const res = await PATCH(makeRequest({ sso_enabled: 1 }), { params: Promise.resolve({ id: user.id }) });
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('password_hash');
    expect(JSON.stringify(body)).not.toContain('__otel_pending__');
  });

  it('rejects a non-admin caller with 403 and does not change the flag', async () => {
    const user = await adminQueries.createAdminUser({ email: 'guarded@sso-admin.test', passwordHash: '__otel_pending__', role: 'pulse' });
    await sql.run(`UPDATE admin_users SET sso_enabled = 0 WHERE id = ?`, [user.id]);

    sessionResult = { authenticated: true, role: 'manager', userId: 'm1', email: 'manager@sso-admin.test' };
    const { PATCH } = await import('../app/api/admin/users/[id]/route');
    const res = await PATCH(makeRequest({ sso_enabled: 1 }), { params: Promise.resolve({ id: user.id }) });
    expect(res.status).toBe(403);

    expect((await adminQueries.findAdminById(user.id))!.sso_enabled).toBe(0);
  });
});

// ─── GET /api/admin/users — autoEnrolled + no password_hash ─────────────────

describe('GET /api/admin/users — autoEnrolled provenance', () => {
  it('includes autoEnrolled: true for a sentinel (__otel_pending__) row', async () => {
    await adminQueries.createAdminUser({ email: 'sentinel@sso-admin.test', passwordHash: '__otel_pending__', role: 'pulse' });

    const { GET } = await import('../app/api/admin/users/route');
    const res = await GET(new NextRequest('http://localhost/api/admin/users'));
    const body = await res.json();
    const found = body.users.find((u: { email: string }) => u.email === 'sentinel@sso-admin.test');
    expect(found).toBeTruthy();
    expect(found.autoEnrolled).toBe(true);
  });

  it('includes autoEnrolled: false for a deliberately-provisioned row', async () => {
    await adminQueries.createAdminUser({ email: 'real@sso-admin.test', passwordHash: 'a-real-scrypt-hash', role: 'admin' });

    const { GET } = await import('../app/api/admin/users/route');
    const res = await GET(new NextRequest('http://localhost/api/admin/users'));
    const body = await res.json();
    const found = body.users.find((u: { email: string }) => u.email === 'real@sso-admin.test');
    expect(found).toBeTruthy();
    expect(found.autoEnrolled).toBe(false);
  });

  it('includes sso_enabled and never leaks password_hash for any row', async () => {
    await adminQueries.createAdminUser({ email: 'shape@sso-admin.test', passwordHash: '__otel_pending__', role: 'pulse' });

    const { GET } = await import('../app/api/admin/users/route');
    const res = await GET(new NextRequest('http://localhost/api/admin/users'));
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain('password_hash');
    expect(raw).not.toContain('__otel_pending__');
    expect(raw).toContain('ssoEnabled');
  });
});
