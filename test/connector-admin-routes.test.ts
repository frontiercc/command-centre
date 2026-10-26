// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

// ── Mocks ──
const configStore: Record<string, string> = {};
vi.mock('@/lib/config', () => ({
  getConfigValue: vi.fn((key: string) => configStore[key] ?? ''),
  setConfigValue: vi.fn((key: string, value: string) => {
    configStore[key] = value;
  }),
}));

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string };
vi.mock('@/lib/auth/admin-auth', () => ({
  getAdminSession: vi.fn(() => sessionResult),
  requireAdmin: vi.fn(() => (sessionResult.authenticated && sessionResult.role === 'admin' ? sessionResult : null)),
}));

let sql: TestSql;
let cleanup: () => Promise<void>;
let route: typeof import('../app/api/admin/connector-tokens/route');
let tokens: typeof import('@/lib/connector/tokens');

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  route = await import('../app/api/admin/connector-tokens/route');
  tokens = await import('@/lib/connector/tokens');
});

afterAll(async () => cleanup());

beforeEach(async () => {
  for (const key of Object.keys(configStore)) delete configStore[key];
  sessionResult = { authenticated: true, role: 'admin', userId: 'u1', email: 'admin@example.com' };
  await sql.run('DELETE FROM connector_tokens');
});

function makeRequest(method: string, body?: unknown, query?: string): NextRequest {
  const url = `http://localhost/api/admin/connector-tokens${query ? `?${query}` : ''}`;
  return new NextRequest(url, {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('GET /api/admin/connector-tokens', () => {
  it('returns 401 when not authenticated', async () => {
    sessionResult = { authenticated: false };
    const res = await route.GET(makeRequest('GET'));
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin roles', async () => {
    sessionResult = { authenticated: true, role: 'viewer' };
    const res = await route.GET(makeRequest('GET'));
    expect(res.status).toBe(403);
  });

  it('returns 200 for admin with tokens[] and endpoints{}', async () => {
    const res = await route.GET(makeRequest('GET'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.tokens)).toBe(true);
    expect(data.endpoints).toMatchObject({
      mcp: expect.stringContaining('/api/mcp'),
      exportSummary: expect.stringContaining('/api/export/summary'),
      exportTrends: expect.stringContaining('/api/export/trends'),
      exportHealth: expect.stringContaining('/api/export/health'),
    });
  });

  it('builds endpoint URLs from digestHubUrl config, defaulting to localhost:3001', async () => {
    const resDefault = await route.GET(makeRequest('GET'));
    const dataDefault = await resDefault.json();
    expect(dataDefault.endpoints.mcp).toBe('http://localhost:3001/api/mcp');

    configStore['digestHubUrl'] = 'https://hub.example.com';
    const res = await route.GET(makeRequest('GET'));
    const data = await res.json();
    expect(data.endpoints.mcp).toBe('https://hub.example.com/api/mcp');
    expect(data.endpoints.exportSummary).toBe('https://hub.example.com/api/export/summary');
  });

  it('list never contains the plaintext token, even right after a mint', async () => {
    const postRes = await route.POST(makeRequest('POST', { name: 'BI tool' }));
    const postData = await postRes.json();
    const plaintext = postData.token as string;

    const getRes = await route.GET(makeRequest('GET'));
    const getData = await getRes.json();
    const serialized = JSON.stringify(getData);
    expect(serialized).not.toContain(plaintext);
    expect(getData.tokens.find((t: { id: string }) => t.id === postData.record.id)).toBeDefined();
  });
});

describe('POST /api/admin/connector-tokens', () => {
  it('returns 403 when not authenticated (requireAdmin contract — matches digest route)', async () => {
    sessionResult = { authenticated: false };
    const res = await route.POST(makeRequest('POST', { name: 'x' }));
    expect(res.status).toBe(403);
  });

  it('returns 403 for non-admin roles', async () => {
    sessionResult = { authenticated: true, role: 'manager' };
    const res = await route.POST(makeRequest('POST', { name: 'x' }));
    expect(res.status).toBe(403);
  });

  it('rejects an empty/whitespace name with 400', async () => {
    const res = await route.POST(makeRequest('POST', { name: '   ' }));
    expect(res.status).toBe(400);
  });

  it('rejects a missing name with 400', async () => {
    const res = await route.POST(makeRequest('POST', {}));
    expect(res.status).toBe(400);
  });

  it('rejects a name over 100 characters with 400', async () => {
    const res = await route.POST(makeRequest('POST', { name: 'a'.repeat(101) }));
    expect(res.status).toBe(400);
  });

  it('accepts a name at the 100-character boundary', async () => {
    const res = await route.POST(makeRequest('POST', { name: 'a'.repeat(100) }));
    expect(res.status).toBe(200);
  });

  it('rejects invalid JSON with 400', async () => {
    const req = new NextRequest('http://localhost/api/admin/connector-tokens', {
      method: 'POST',
      body: '{not valid json',
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await route.POST(req);
    expect(res.status).toBe(400);
  });

  it('mints and returns { token, record } with plaintext only in this response', async () => {
    const res = await route.POST(makeRequest('POST', { name: '  BI export  ' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data.token).toBe('string');
    expect(data.token.length).toBeGreaterThanOrEqual(43);
    expect(data.record.name).toBe('BI export'); // trimmed
    expect(data.record.id).toBeTruthy();
    expect(data.record.revokedAt).toBeNull();
    expect(data.record).not.toHaveProperty('token');
    expect(data.record).not.toHaveProperty('tokenHash');
  });
});

describe('DELETE /api/admin/connector-tokens', () => {
  it('returns 403 when not authenticated (requireAdmin contract — matches digest route)', async () => {
    sessionResult = { authenticated: false };
    const res = await route.DELETE(makeRequest('DELETE', undefined, 'id=whatever'));
    expect(res.status).toBe(403);
  });

  it('returns 403 for non-admin roles', async () => {
    sessionResult = { authenticated: true, role: 'manager' };
    const res = await route.DELETE(makeRequest('DELETE', undefined, 'id=whatever'));
    expect(res.status).toBe(403);
  });

  it('returns 400 when id is missing', async () => {
    const res = await route.DELETE(makeRequest('DELETE'));
    expect(res.status).toBe(400);
  });

  it('revoke round-trip: mint -> revoke true -> revoke again false -> shows revokedAt in list', async () => {
    const { record } = await tokens.mintConnectorToken('to-revoke');

    const res1 = await route.DELETE(makeRequest('DELETE', undefined, `id=${record.id}`));
    expect(res1.status).toBe(200);
    expect((await res1.json()).revoked).toBe(true);

    const res2 = await route.DELETE(makeRequest('DELETE', undefined, `id=${record.id}`));
    expect((await res2.json()).revoked).toBe(false);

    const listRes = await route.GET(makeRequest('GET'));
    const listData = await listRes.json();
    const entry = listData.tokens.find((t: { id: string }) => t.id === record.id);
    expect(entry.revokedAt).not.toBeNull();
  });

  it('returns revoked:false for an unknown id', async () => {
    const res = await route.DELETE(makeRequest('DELETE', undefined, 'id=does-not-exist'));
    expect(res.status).toBe(200);
    expect((await res.json()).revoked).toBe(false);
  });
});
