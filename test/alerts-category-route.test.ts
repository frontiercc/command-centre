// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';
import { seedUserSql } from './helpers/seed';
import { typesForCategory } from '@/lib/alerts/categories';

// Auth + audit are mocked so the route test below can run against a real
// temp DB (via createTestDatabase) without needing a real session/cookie or an
// audit-log table. @/lib/db/queries is deliberately NOT mocked — both the
// direct getAlerts() tests and the route-level tests exercise the real
// query against a real temp Postgres DB, mirroring test/alert-queries.test.ts.
vi.mock('@/lib/auth/admin-auth', () => ({
  getAdminSession: vi.fn(async () => ({
    authenticated: true, role: 'admin', userId: 'u1', email: 'a@example.com', department: null,
  })),
  canAccessCorePlatform: () => true,
  requireAdmin: vi.fn(async () => null),
  isDeptScoped: (role: string | undefined) => role === 'cowork' || role === 'pulse' || role === 'code',
}));
vi.mock('@/lib/audit/log', () => ({
  logAccess: vi.fn(async () => {}),
}));

let sql: TestSql;
let cleanup: () => Promise<void>;
let getAlerts: (filters?: { status?: string; department?: string; types?: string[] }) => Promise<any[]>;
let insertAlert: (alert: {
  id: string; user_id: string | null; alert_type: string;
  severity: string; title: string; explanation: string; raw_evidence: string;
}) => Promise<void>;
let updateAlertStatus: (id: string, status: string, resolvedBy?: string) => Promise<void>;
let bulkUpdateAlertStatus: (
  fromStatus: string,
  toStatus: string,
  resolvedBy?: string,
  types?: string[]
) => Promise<number>;
let GET: (request: any) => Promise<Response>;
// Module namespace kept around (in addition to the destructured `getAlerts`
// above) so the department-scoping describe below can vi.spyOn() the same
// module instance the route imports — see that block for why.
let queriesModule: typeof import('@/lib/db/queries');

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const queries = await import('@/lib/db/queries');
  queriesModule = queries;
  getAlerts = queries.getAlerts as typeof getAlerts;
  insertAlert = queries.insertAlert;
  updateAlertStatus = queries.updateAlertStatus;
  bulkUpdateAlertStatus = queries.bulkUpdateAlertStatus;

  const route = await import('@/app/api/alerts/route');
  GET = route.GET as typeof GET;

  await seedUserSql(sql, 'user-1');
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec('DELETE FROM alerts');
});

async function insertTestAlert(id: string, alertType: string) {
  await insertAlert({
    id,
    user_id: 'user-1',
    alert_type: alertType,
    severity: 'medium',
    title: 'Test alert',
    explanation: 'Test explanation',
    raw_evidence: '{}',
  });
}

// ─── getAlerts({ types }) — direct query-level assertions ─────────────────

describe('getAlerts({ types })', () => {
  it('restricts to the given alert types (a policy alert, which is security-compliance, is excluded)', async () => {
    await insertTestAlert('a-policy', 'policy');
    await insertTestAlert('a-cost', 'code_cost_spike');
    await insertTestAlert('a-friction', 'code_friction');

    const types = typesForCategory('cost-efficiency');
    expect(types).toEqual(['code_cost_spike', 'code_friction', 'finance_reconciliation_drift']);

    const results = await getAlerts({ types });
    expect(results.map((r) => r.id).sort()).toEqual(['a-cost', 'a-friction']);
  });

  it('composes types with status', async () => {
    await insertTestAlert('a-policy-open', 'policy');
    await insertTestAlert('a-policy-resolved', 'policy');
    // code_cost_spike is cost-efficiency, genuinely outside security-compliance
    // under the new taxonomy (unlike anomaly, which now lives inside it).
    await insertTestAlert('a-cost-open', 'code_cost_spike');
    await updateAlertStatus('a-policy-resolved', 'resolved', 'admin');

    const types = typesForCategory('security-compliance');
    const results = await getAlerts({ types, status: 'open' });
    expect(results.map((r) => r.id)).toEqual(['a-policy-open']);
  });

  it('returns everything when types is empty/undefined (unknown category)', async () => {
    await insertTestAlert('a-policy', 'policy');
    await insertTestAlert('a-anomaly', 'anomaly');

    const unknownTypes = typesForCategory('not-a-real-category');
    expect(unknownTypes).toEqual([]);

    const results = await getAlerts({ types: unknownTypes.length ? unknownTypes : undefined });
    expect(results.map((r) => r.id).sort()).toEqual(['a-anomaly', 'a-policy']);
  });
});

// ─── GET /api/alerts?category=... — route-level integration ──────────────

describe('GET /api/alerts — category param', () => {
  it('?category=cost-efficiency restricts to those types (a policy alert is excluded)', async () => {
    await insertTestAlert('a-policy', 'policy');
    await insertTestAlert('a-cost', 'code_cost_spike');
    await insertTestAlert('a-friction', 'code_friction');

    const { NextRequest } = await import('next/server');
    const req = new NextRequest('http://localhost/api/alerts?category=cost-efficiency');
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.map((r) => r.id).sort()).toEqual(['a-cost', 'a-friction']);
  });

  it('?category=security-compliance&status=open composes both', async () => {
    await insertTestAlert('a-policy-open', 'policy');
    await insertTestAlert('a-policy-resolved', 'policy');
    // code_cost_spike is genuinely outside security-compliance under the new map.
    await insertTestAlert('a-cost-open', 'code_cost_spike');
    await updateAlertStatus('a-policy-resolved', 'resolved', 'admin');

    const { NextRequest } = await import('next/server');
    const req = new NextRequest('http://localhost/api/alerts?category=security-compliance&status=open');
    const res = await GET(req);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.map((r) => r.id)).toEqual(['a-policy-open']);
  });

  it('unknown ?category=foo returns unfiltered-by-category results', async () => {
    await insertTestAlert('a-policy', 'policy');
    await insertTestAlert('a-anomaly', 'anomaly');

    const { NextRequest } = await import('next/server');
    const req = new NextRequest('http://localhost/api/alerts?category=foo');
    const res = await GET(req);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.map((r) => r.id).sort()).toEqual(['a-anomaly', 'a-policy']);
  });

  it('absent category returns unfiltered-by-category results', async () => {
    await insertTestAlert('a-policy', 'policy');
    await insertTestAlert('a-anomaly', 'anomaly');

    const { NextRequest } = await import('next/server');
    const req = new NextRequest('http://localhost/api/alerts');
    const res = await GET(req);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.map((r) => r.id).sort()).toEqual(['a-anomaly', 'a-policy']);
  });
});

// ─── bulkUpdateAlertStatus({ types }) — category-scoped bulk actions ──────

describe('bulkUpdateAlertStatus with types', () => {
  it('only flips alerts whose type is in the given category, leaving others open', async () => {
    await insertTestAlert('a-policy', 'policy');
    await insertTestAlert('a-intent', 'intent');
    await insertTestAlert('a-repo', 'code_repo_exposure');
    await insertTestAlert('a-model-policy', 'code_model_policy');
    // Both now live under security-compliance in the new taxonomy (no standalone Risk bucket).
    await insertTestAlert('a-risk', 'risk');
    await insertTestAlert('a-anomaly', 'anomaly');
    await insertTestAlert('a-cost', 'code_cost_spike');

    const types = typesForCategory('security-compliance');
    const updated = await bulkUpdateAlertStatus('open', 'resolved', 'admin', types);
    expect(updated).toBe(6);

    const resolved = await getAlerts({ status: 'resolved' });
    expect(resolved.map((r) => r.id).sort()).toEqual([
      'a-anomaly', 'a-intent', 'a-model-policy', 'a-policy', 'a-repo', 'a-risk',
    ]);

    const stillOpen = await getAlerts({ status: 'open' });
    expect(stillOpen.map((r) => r.id).sort()).toEqual(['a-cost']);
  });

  it('undefined/empty types preserves existing status-only behaviour', async () => {
    await insertTestAlert('a-policy', 'policy');
    await insertTestAlert('a-anomaly', 'anomaly');

    const updated = await bulkUpdateAlertStatus('open', 'dismissed', 'admin');
    expect(updated).toBe(2);

    const stillOpen = await getAlerts({ status: 'open' });
    expect(stillOpen).toEqual([]);
  });
});

// ─── GET /api/alerts — department scoping (admin dept-scoping bug-fix) ────
//
// Regression coverage for app/api/alerts/route.ts:34 —
//   isDeptScoped(session.role) ? (session.department || undefined)
//                               : (params.get('department') || undefined)
// The bug this guards against: an admin/viewer with session.department set
// used to get force-scoped to their own department. These tests drive the
// real GET handler and assert the exact `department` value it hands to
// getAlerts(), rather than asserting on the response body (which the other
// describes above already cover for the types/category filter).
//
// getAlerts is spied (not vi.mock'd at the module level) on the SAME module
// namespace object the route imported in beforeAll — @/lib/db/queries is
// deliberately not mocked elsewhere in this file so the other describes can
// exercise the real query, so a full vi.mock() here would break them. The
// spy fully replaces the implementation (mockResolvedValue([])) purely to
// capture call args without touching alert rows.
describe('GET /api/alerts — department scoping (admin dept-scoping fix)', () => {
  let getAlertsSpy: any;

  beforeEach(() => {
    getAlertsSpy = vi.spyOn(queriesModule, 'getAlerts').mockResolvedValue([]);
  });

  afterEach(() => {
    getAlertsSpy.mockRestore();
  });

  it('admin with session.department set is NOT force-scoped when no ?department param is given', async () => {
    const adminAuth = await import('@/lib/auth/admin-auth');
    vi.mocked(adminAuth.getAdminSession).mockResolvedValueOnce({
      authenticated: true, role: 'admin', department: 'Finance', userId: 'x', email: 'a@x',
    } as any);

    const { NextRequest } = await import('next/server');
    const req = new NextRequest('http://localhost/api/alerts');
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(getAlertsSpy).toHaveBeenCalledWith(expect.objectContaining({ department: undefined }));
  });

  it('admin may optionally filter via ?department=Sales', async () => {
    const adminAuth = await import('@/lib/auth/admin-auth');
    vi.mocked(adminAuth.getAdminSession).mockResolvedValueOnce({
      authenticated: true, role: 'admin', department: 'Finance', userId: 'x', email: 'a@x',
    } as any);

    const { NextRequest } = await import('next/server');
    const req = new NextRequest('http://localhost/api/alerts?department=Sales');
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(getAlertsSpy).toHaveBeenCalledWith(expect.objectContaining({ department: 'Sales' }));
  });

  // isDeptScoped(role) is mocked true for 'code'/'cowork'/'pulse'. The mocked
  // canAccessCorePlatform in this file always returns true regardless of role
  // (it doesn't branch on role at all), so this request reaches getAlerts —
  // the gate is not a factor here, unlike the real canAccessCorePlatform which
  // would 403 a dept-scoped role in production. If that ever changes such that
  // this mock starts 403'ing dept-scoped roles, assert the 403 instead.
  it('a dept-scoped role is locked to session.department and a query-param override is ignored', async () => {
    const adminAuth = await import('@/lib/auth/admin-auth');
    vi.mocked(adminAuth.getAdminSession).mockResolvedValueOnce({
      authenticated: true, role: 'code', department: 'Engineering', userId: 'y', email: 'b@x',
    } as any);

    const { NextRequest } = await import('next/server');
    const req = new NextRequest('http://localhost/api/alerts?department=Everything');
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(getAlertsSpy).toHaveBeenCalledWith(expect.objectContaining({ department: 'Engineering' }));
  });
});
