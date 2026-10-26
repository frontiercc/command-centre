// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

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

function makeRequest(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(`http://localhost${url}`, init);
}

function jsonRequest(url: string, method: string, body?: unknown): NextRequest {
  // Creating a use case needs a description (sessions are
  // judged against it); tests that do not care about it get a default here.
  const withDesc = method === 'POST' && url === '/api/use-cases' && body && typeof body === 'object' && !('description' in (body as object))
    ? { ...(body as object), description: 'Test work: what it is and what it produces.' }
    : body;
  return new NextRequest(`http://localhost${url}`, {
    method,
    body: withDesc !== undefined ? JSON.stringify(withDesc) : undefined,
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
  await sql.exec('DELETE FROM use_cases');
  await sql.exec('DELETE FROM config');
  await sql.exec('DELETE FROM cowork_messages');
  await sql.exec('DELETE FROM cowork_skill_invocations');
  await sql.exec('DELETE FROM users');
  sessionResult = { authenticated: true, role: 'admin', userId: 'admin-1', email: 'admin@example.com' };
});

async function enableUseCases() {
  const { saveConfig } = await import('@/lib/config');
  await saveConfig({ useCasesEnabled: 'true' });
}

describe('GET /api/use-cases/summary — gates', () => {
  it('returns 404 when the feature flag is off', async () => {
    const { GET } = await import('../app/api/use-cases/summary/route');
    const res = await GET(makeRequest('/api/use-cases/summary'));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Not found');
  });

  it('returns 401 when not authenticated', async () => {
    await enableUseCases();
    sessionResult = { authenticated: false };
    const { GET } = await import('../app/api/use-cases/summary/route');
    const res = await GET(makeRequest('/api/use-cases/summary'));
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin/manager role', async () => {
    await enableUseCases();
    sessionResult = { authenticated: true, role: 'viewer', userId: 'v1' };
    const { GET } = await import('../app/api/use-cases/summary/route');
    const res = await GET(makeRequest('/api/use-cases/summary'));
    expect(res.status).toBe(403);
  });
});

describe('GET /api/use-cases/summary — counts', () => {
  it('counts non-archived use cases by lifecycle, excluding archived from every bucket', async () => {
    await enableUseCases();
    const { POST } = await import('../app/api/use-cases/route');

    // 1: confirmed, will be adopted
    const adopted = await (await POST(jsonRequest('/api/use-cases', 'POST', { title: 'Adopted UC' }))).json();
    // 2: confirmed, not_seen (default lifecycle)
    await POST(jsonRequest('/api/use-cases', 'POST', { title: 'Not seen UC' }));
    // 3: archived-adopted — must be excluded from declared AND adopted
    const archived = await (await POST(jsonRequest('/api/use-cases', 'POST', { title: 'Archived adopted UC' }))).json();

    await sql.run(`UPDATE use_cases SET lifecycle = 'adopted' WHERE id = ?`, [adopted.id]);
    await sql.run(`UPDATE use_cases SET lifecycle = 'adopted', status = 'archived' WHERE id = ?`, [archived.id]);

    const { GET } = await import('../app/api/use-cases/summary/route');
    const res = await GET(makeRequest('/api/use-cases/summary'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      declared: 2,
      adopted: 1,
      piloting: 0,
      atRisk: 0,
      notSeen: 1,
    });
  });
});
