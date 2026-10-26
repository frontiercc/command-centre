// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// POST /api/pulse/coaching/ack — "Mark done" on a Coaching Prompts row.
// Harness copied from test/use-cases-routes.test.ts.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string };
vi.mock('@/lib/auth/admin-auth', () => ({
  getAdminSession: vi.fn(() => sessionResult),
  canAccessPulseAdmin: (role?: string) => role === 'admin' || role === 'manager',
}));

function jsonRequest(body?: unknown, method: 'POST' | 'DELETE' = 'POST'): NextRequest {
  return new NextRequest('http://localhost/api/pulse/coaching/ack', {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  vi.resetModules();
  await sql.exec('DELETE FROM coaching_acks');
  await sql.exec('DELETE FROM use_cases');
  await sql.exec('DELETE FROM users');
  await sql.exec('DELETE FROM config');
  sessionResult = { authenticated: true, role: 'admin', userId: 'admin-1', email: 'admin@example.com' };
});

async function enableUseCases() {
  const { saveConfig } = await import('@/lib/config');
  await saveConfig({ useCasesEnabled: 'true' });
}

async function seedUserAndUseCase() {
  const { schema } = await import('@/lib/db/schema');
  const { getTypedClient } = await import('@/lib/db/client');
  const client = await getTypedClient();
  const now = Math.floor(Date.now() / 1000);
  await client.insert(schema.users).values({ id: 'u-anna', email: 'anna@test.local', display_name: 'Anna' });
  await client.insert(schema.useCases).values({ id: 'uc-1', title: 'Board-Pack Prep', status: 'confirmed', created_at: now, updated_at: now });
}

describe('config gate — useCasesEnabled', () => {
  it('returns 404 when disabled, before auth is even checked', async () => {
    sessionResult = { authenticated: false };
    const { POST } = await import('../app/api/pulse/coaching/ack/route');
    const res = await POST(jsonRequest({ userId: 'u-anna', useCaseId: 'uc-1' }));
    expect(res.status).toBe(404);
  });
});

describe('RBAC — admin/manager only', () => {
  it('returns 401 when not authenticated', async () => {
    await enableUseCases();
    sessionResult = { authenticated: false };
    const { POST } = await import('../app/api/pulse/coaching/ack/route');
    const res = await POST(jsonRequest({ userId: 'u-anna', useCaseId: 'uc-1' }));
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin/manager role', async () => {
    await enableUseCases();
    sessionResult = { authenticated: true, role: 'viewer', userId: 'v1' };
    const { POST } = await import('../app/api/pulse/coaching/ack/route');
    const res = await POST(jsonRequest({ userId: 'u-anna', useCaseId: 'uc-1' }));
    expect(res.status).toBe(403);
  });

  it('allows manager role', async () => {
    await enableUseCases();
    await seedUserAndUseCase();
    sessionResult = { authenticated: true, role: 'manager', userId: 'm1', email: 'm1@example.com' };
    const { POST } = await import('../app/api/pulse/coaching/ack/route');
    const res = await POST(jsonRequest({ userId: 'u-anna', useCaseId: 'uc-1' }));
    expect(res.status).toBe(200);
  });
});

describe('validation', () => {
  it('returns 400 for a missing or blank userId/useCaseId', async () => {
    await enableUseCases();
    const { POST } = await import('../app/api/pulse/coaching/ack/route');
    expect((await POST(jsonRequest({ useCaseId: 'uc-1' }))).status).toBe(400);
    expect((await POST(jsonRequest({ userId: 'u-anna' }))).status).toBe(400);
    expect((await POST(jsonRequest({ userId: '', useCaseId: 'uc-1' }))).status).toBe(400);
    expect((await POST(jsonRequest({ userId: 'u-anna', useCaseId: '   ' }))).status).toBe(400);
  });

  it('returns 400 for a userId/useCaseId over 200 characters', async () => {
    await enableUseCases();
    const { POST } = await import('../app/api/pulse/coaching/ack/route');
    const tooLong = 'x'.repeat(201);
    expect((await POST(jsonRequest({ userId: tooLong, useCaseId: 'uc-1' }))).status).toBe(400);
    expect((await POST(jsonRequest({ userId: 'u-anna', useCaseId: tooLong }))).status).toBe(400);
  });

  it('returns 400 for an invalid JSON body', async () => {
    await enableUseCases();
    const { POST } = await import('../app/api/pulse/coaching/ack/route');
    const badReq = new NextRequest('http://localhost/api/pulse/coaching/ack', { method: 'POST', body: 'not json', headers: { 'Content-Type': 'application/json' } });
    expect((await POST(badReq)).status).toBe(400);
  });

  it('returns 404 when the use case does not exist', async () => {
    await enableUseCases();
    await seedUserAndUseCase();
    const { POST } = await import('../app/api/pulse/coaching/ack/route');
    const res = await POST(jsonRequest({ userId: 'u-anna', useCaseId: 'does-not-exist' }));
    expect(res.status).toBe(404);
  });

  it('returns 404 when the user does not exist', async () => {
    await enableUseCases();
    await seedUserAndUseCase();
    const { POST } = await import('../app/api/pulse/coaching/ack/route');
    const res = await POST(jsonRequest({ userId: 'does-not-exist', useCaseId: 'uc-1' }));
    expect(res.status).toBe(404);
  });
});

describe('happy path', () => {
  it('persists an ack row keyed on the admin email, returns {ok:true}, and a repeat ack is idempotent', async () => {
    await enableUseCases();
    await seedUserAndUseCase();
    const { POST } = await import('../app/api/pulse/coaching/ack/route');

    const res = await POST(jsonRequest({ userId: 'u-anna', useCaseId: 'uc-1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const rows = await sql.all<{ user_id: string; use_case_id: string; acked_by: string }>('SELECT * FROM coaching_acks');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: 'u-anna', use_case_id: 'uc-1', acked_by: 'admin@example.com' });

    const res2 = await POST(jsonRequest({ userId: 'u-anna', useCaseId: 'uc-1' }));
    expect(res2.status).toBe(200);
    expect(await sql.all('SELECT * FROM coaching_acks')).toHaveLength(1);
  });
});

describe('DELETE — undo (Mark done -> Undo)', () => {
  it('returns 404 when disabled, before auth is even checked', async () => {
    sessionResult = { authenticated: false };
    const { DELETE } = await import('../app/api/pulse/coaching/ack/route');
    const res = await DELETE(jsonRequest({ userId: 'u-anna', useCaseId: 'uc-1' }, 'DELETE'));
    expect(res.status).toBe(404);
  });

  it('returns 401 when not authenticated', async () => {
    await enableUseCases();
    sessionResult = { authenticated: false };
    const { DELETE } = await import('../app/api/pulse/coaching/ack/route');
    const res = await DELETE(jsonRequest({ userId: 'u-anna', useCaseId: 'uc-1' }, 'DELETE'));
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin/manager role', async () => {
    await enableUseCases();
    sessionResult = { authenticated: true, role: 'viewer', userId: 'v1' };
    const { DELETE } = await import('../app/api/pulse/coaching/ack/route');
    const res = await DELETE(jsonRequest({ userId: 'u-anna', useCaseId: 'uc-1' }, 'DELETE'));
    expect(res.status).toBe(403);
  });

  it('returns 400 for a missing or blank userId/useCaseId', async () => {
    await enableUseCases();
    const { DELETE } = await import('../app/api/pulse/coaching/ack/route');
    expect((await DELETE(jsonRequest({ useCaseId: 'uc-1' }, 'DELETE'))).status).toBe(400);
    expect((await DELETE(jsonRequest({ userId: 'u-anna' }, 'DELETE'))).status).toBe(400);
    expect((await DELETE(jsonRequest({ userId: '', useCaseId: 'uc-1' }, 'DELETE'))).status).toBe(400);
  });

  it('returns 400 for a userId/useCaseId over 200 characters', async () => {
    await enableUseCases();
    const { DELETE } = await import('../app/api/pulse/coaching/ack/route');
    const tooLong = 'x'.repeat(201);
    expect((await DELETE(jsonRequest({ userId: tooLong, useCaseId: 'uc-1' }, 'DELETE'))).status).toBe(400);
  });

  it('returns 400 for an invalid JSON body', async () => {
    await enableUseCases();
    const { DELETE } = await import('../app/api/pulse/coaching/ack/route');
    const badReq = new NextRequest('http://localhost/api/pulse/coaching/ack', { method: 'DELETE', body: 'not json', headers: { 'Content-Type': 'application/json' } });
    expect((await DELETE(badReq)).status).toBe(400);
  });

  it('removes an acked pair, returns {ok:true}, and a repeat delete is idempotent', async () => {
    await enableUseCases();
    await seedUserAndUseCase();
    const { POST, DELETE } = await import('../app/api/pulse/coaching/ack/route');

    await POST(jsonRequest({ userId: 'u-anna', useCaseId: 'uc-1' }));
    expect(await sql.all('SELECT * FROM coaching_acks')).toHaveLength(1);

    const res = await DELETE(jsonRequest({ userId: 'u-anna', useCaseId: 'uc-1' }, 'DELETE'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await sql.all('SELECT * FROM coaching_acks')).toHaveLength(0);

    // Idempotent: deleting a pair that was never (or is no longer) acked is a no-op, not an error.
    const res2 = await DELETE(jsonRequest({ userId: 'u-anna', useCaseId: 'uc-1' }, 'DELETE'));
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ ok: true });
    expect(await sql.all('SELECT * FROM coaching_acks')).toHaveLength(0);
  });

  it('does not require the user/use-case to still exist (undo only needs the pair)', async () => {
    await enableUseCases();
    const { DELETE } = await import('../app/api/pulse/coaching/ack/route');
    const res = await DELETE(jsonRequest({ userId: 'does-not-exist', useCaseId: 'does-not-exist-either' }, 'DELETE'));
    expect(res.status).toBe(200);
  });
});
