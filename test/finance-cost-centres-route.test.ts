// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
// first_seen_at/last_seen_at for seeded users (bound as a parameter).
const SEED_NOW = Math.floor(Date.now() / 1000);

const cfg = { chargebackEnabled: true };
vi.mock('@/lib/config', () => ({
  getAllConfig: () => cfg,
}));

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string };
vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return {
    ...actual,
    getAdminSession: () => sessionResult,
    // requireAdmin in the real module calls its own module-local getAdminSession
    // binding (not the mocked export), so it must be overridden directly here too.
    requireAdmin: () => (sessionResult.authenticated && sessionResult.role === 'admin' ? sessionResult : null),
  };
});

const logAccessMock = vi.fn();
vi.mock('@/lib/audit/log', () => ({
  logAccess: logAccessMock,
}));

function makeRequest(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(`http://localhost${url}`, init);
}

function jsonRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
  vi.resetModules();
  cfg.chargebackEnabled = true;
  logAccessMock.mockClear();
  await sql.exec('DELETE FROM chargeback_dept_map');
  await sql.exec('DELETE FROM chargeback_cost_centres');
  await sql.exec('DELETE FROM users');
  sessionResult = { authenticated: true, role: 'admin', userId: 'admin-1', email: 'admin@example.com' };
});

describe('GET /api/finance/cost-centres', () => {
  it('returns 404 when the feature flag is off', async () => {
    cfg.chargebackEnabled = false;
    const { GET } = await import('../app/api/finance/cost-centres/route');
    const res = await GET(makeRequest('/api/finance/cost-centres'));
    expect(res.status).toBe(404);
  });

  it('returns 403 for a manager role (admin-only)', async () => {
    sessionResult = { authenticated: true, role: 'manager', userId: 'm1', email: 'm@x.test' };
    const { GET } = await import('../app/api/finance/cost-centres/route');
    const res = await GET(makeRequest('/api/finance/cost-centres'));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Forbidden: admin role required');
  });
});

describe('POST /api/finance/cost-centres', () => {
  it('returns 404 when the feature flag is off', async () => {
    cfg.chargebackEnabled = false;
    const { POST } = await import('../app/api/finance/cost-centres/route');
    const res = await POST(jsonRequest('/api/finance/cost-centres', 'POST', { action: 'createCentre', name: 'R&D' }));
    expect(res.status).toBe(404);
  });

  it('returns 403 for a manager role (admin-only)', async () => {
    sessionResult = { authenticated: true, role: 'manager', userId: 'm1', email: 'm@x.test' };
    const { POST } = await import('../app/api/finance/cost-centres/route');
    const res = await POST(jsonRequest('/api/finance/cost-centres', 'POST', { action: 'createCentre', name: 'R&D' }));
    expect(res.status).toBe(403);
  });
});

describe('admin workflow', () => {
  it('drives the full createCentre -> dup 409 -> mapDept -> GET -> bad costCentreId -> unknown action flow', async () => {
    await sql.run(
      `INSERT INTO users (id, email, display_name, source, department, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, 'otel', ?, ?, ?)`,
      ['u-eng-1', 'eng1@test.com', 'Eng One', 'Engineering', SEED_NOW, SEED_NOW]);

    const { GET, POST } = await import('../app/api/finance/cost-centres/route');

    // createCentre
    const createRes = await POST(jsonRequest('/api/finance/cost-centres', 'POST', {
      action: 'createCentre',
      name: 'R&D',
      code: '4100',
    }));
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.name).toBe('R&D');
    expect(created.code).toBe('4100');
    expect(typeof created.id).toBe('number');
    expect(logAccessMock).toHaveBeenCalledWith(
      expect.objectContaining({ resource: 'finance/cost-centres', action: 'WRITE', outcome: 'success' })
    );

    // duplicate name, case-insensitive
    const dupRes = await POST(jsonRequest('/api/finance/cost-centres', 'POST', {
      action: 'createCentre',
      name: 'r&d',
    }));
    expect(dupRes.status).toBe(409);
    expect((await dupRes.json()).error).toBe('A cost centre with that name already exists');

    // mapDept
    const mapRes = await POST(jsonRequest('/api/finance/cost-centres', 'POST', {
      action: 'mapDept',
      department: 'Engineering',
      costCentreId: created.id,
    }));
    expect(mapRes.status).toBe(200);
    expect((await mapRes.json()).ok).toBe(true);

    // GET reflects state
    const getRes = await GET(makeRequest('/api/finance/cost-centres'));
    expect(getRes.status).toBe(200);
    const body = await getRes.json();
    expect(body.centres).toHaveLength(1);
    expect(body.centres[0]).toEqual({ id: created.id, name: 'R&D', code: '4100' });
    expect(body.map).toEqual([{ department: 'Engineering', costCentreId: created.id }]);
    expect(body.departments).toContain('Engineering');
    expect(logAccessMock).toHaveBeenCalledWith(
      expect.objectContaining({ resource: 'finance/cost-centres', action: 'READ', outcome: 'success' })
    );

    // mapDept with non-existent costCentreId
    const badMapRes = await POST(jsonRequest('/api/finance/cost-centres', 'POST', {
      action: 'mapDept',
      department: 'Data',
      costCentreId: 999999,
    }));
    expect(badMapRes.status).toBe(400);

    // unmapDept
    const unmapRes = await POST(jsonRequest('/api/finance/cost-centres', 'POST', {
      action: 'unmapDept',
      department: 'Engineering',
    }));
    expect(unmapRes.status).toBe(200);
    expect((await unmapRes.json()).ok).toBe(true);
    const getRes2 = await GET(makeRequest('/api/finance/cost-centres'));
    expect((await getRes2.json()).map).toEqual([]);

    // renameCentre
    const renameRes = await POST(jsonRequest('/api/finance/cost-centres', 'POST', {
      action: 'renameCentre',
      id: created.id,
      name: 'Research & Development',
      code: '4101',
    }));
    expect(renameRes.status).toBe(200);
    expect((await renameRes.json()).ok).toBe(true);

    // renameCentre 404 for missing id
    const renameMissingRes = await POST(jsonRequest('/api/finance/cost-centres', 'POST', {
      action: 'renameCentre',
      id: 999999,
      name: 'Whatever',
    }));
    expect(renameMissingRes.status).toBe(404);

    // deleteCentre
    const deleteRes = await POST(jsonRequest('/api/finance/cost-centres', 'POST', {
      action: 'deleteCentre',
      id: created.id,
    }));
    expect(deleteRes.status).toBe(200);
    expect((await deleteRes.json()).ok).toBe(true);
    const getRes3 = await GET(makeRequest('/api/finance/cost-centres'));
    expect((await getRes3.json()).centres).toEqual([]);

    // deleteCentre no-op when id absent
    const deleteAgainRes = await POST(jsonRequest('/api/finance/cost-centres', 'POST', {
      action: 'deleteCentre',
      id: created.id,
    }));
    expect(deleteAgainRes.status).toBe(200);

    // unknown action
    const bogusRes = await POST(jsonRequest('/api/finance/cost-centres', 'POST', { action: 'bogus' }));
    expect(bogusRes.status).toBe(400);
    expect((await bogusRes.json()).error).toBe('Unknown action');

    // malformed JSON body
    const malformedRes = await POST(new NextRequest('http://localhost/api/finance/cost-centres', {
      method: 'POST',
      body: '{not json',
      headers: { 'Content-Type': 'application/json' },
    }));
    expect(malformedRes.status).toBe(400);
  });

  it('createCentre requires a non-empty name', async () => {
    const { POST } = await import('../app/api/finance/cost-centres/route');
    const res = await POST(jsonRequest('/api/finance/cost-centres', 'POST', { action: 'createCentre', name: '   ' }));
    expect(res.status).toBe(400);
  });

  it('mapDept requires a non-empty department', async () => {
    const { POST } = await import('../app/api/finance/cost-centres/route');
    const createRes = await POST(jsonRequest('/api/finance/cost-centres', 'POST', { action: 'createCentre', name: 'Ops' }));
    const created = await createRes.json();
    const res = await POST(jsonRequest('/api/finance/cost-centres', 'POST', {
      action: 'mapDept',
      department: '',
      costCentreId: created.id,
    }));
    expect(res.status).toBe(400);
  });
});
