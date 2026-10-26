// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// A3 (docs/POSTGRES-LOCAL-FULL-PLAN.md): Postgres regression test for
// /api/pulse/admin/users. This route carried the SAME PG-only bug PR #6 fixed
// in the Developer Pulse users/depts routes: an optional dept filter written as
// `(${deptFilter ?? null} IS NULL OR u.department = ${deptFilter})`. On
// Postgres a standalone `$1 IS NULL` has no
// inferable type → "could not determine data type of parameter $1" → HTTP 500.
// The no-dept branch (admin, no ?dept → deptFilter null) is exactly that case.
// Proven red against the pre-fix pattern before the fix.
//
// Harness mirrors test/pulse-admin-routes-pg.test.ts: one runSpec() against a
// migrated Postgres database (createTestDbClient('postgres')). getAdminSession
// is mocked; every route module is imported AFTER the database env is
// established.
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockSession: { authenticated: boolean; role?: string; email?: string; userId?: string; department?: string | null } = {
  authenticated: true,
  role: 'admin',
  email: 'admin@test.com',
  userId: 'admin1',
};

vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return {
    ...actual,
    getAdminSession: async () => mockSession,
  };
});

function makeRequest(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

const NOW = Math.floor(Date.now() / 1000);
const DAY = 24 * 3600;

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const h = await createTestDbClient('postgres');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = h.client;
  const cleanup = h.cleanup;

  try {
    const { schema } = await import('@/lib/db/schema');

    // Two users in DIFFERENT departments so the dept filter is discriminating.
    await client.insert(schema.users).values([
      { id: 'u1', email: 'u1@test.com', display_name: 'Ada Lovelace', department: 'Engineering' },
      { id: 'u2', email: 'u2@test.com', display_name: 'Grace Hopper', department: 'Sales' },
    ]);

    // Each user needs ≥1 cowork message so the route's EXISTS gate includes them.
    await client.insert(schema.coworkMessages).values([
      { id: 'cm1', session_id: 's1', user_id: 'u1', message_type: 'cowork_user_message', surface: 'cowork', occurred_at: NOW - DAY },
      { id: 'cm2', session_id: 's2', user_id: 'u2', message_type: 'cowork_user_message', surface: 'cowork', occurred_at: NOW - DAY },
    ]);

    // Latest user-scope rolling pulse_metrics row per user (dds drives ordering).
    await client.insert(schema.pulseMetrics).values([
      { scope_type: 'user', scope_id: 'u1', period_start: NOW - 7 * DAY, period_end: NOW, dds: 5.0, oti: 2.0, granularity: 'rolling', computed_at: NOW },
      { scope_type: 'user', scope_id: 'u2', period_start: NOW - 7 * DAY, period_end: NOW, dds: 2.0, oti: 1.0, granularity: 'rolling', computed_at: NOW },
    ]);

    const { GET } = await import('../app/api/pulse/admin/users/route');

    // ── No-dept branch (admin, no ?dept): the pre-fix PG-500 case. ──
    const allRes = await GET(makeRequest('/api/pulse/admin/users'));
    expect(allRes.status).toBe(200);
    const allBody = await allRes.json();
    expect(allBody.users).toHaveLength(2);
    // Ordered by dds DESC NULLS LAST → u1 (5.0) before u2 (2.0).
    expect(allBody.users[0].id).toBe('u1');
    expect(allBody.users[0].department).toBe('Engineering');
    expect(allBody.users[0].dds).toBeCloseTo(5.0, 6);
    expect(allBody.users[1].id).toBe('u2');
    // Coerced COUNT(*) subqueries come back as real JS numbers.
    expect(typeof allBody.users[0].pending_count).toBe('number');
    expect(typeof allBody.users[0].failed_count).toBe('number');

    // ── Dept-filter branch: a match on each department. ──
    const engRes = await GET(makeRequest('/api/pulse/admin/users?dept=Engineering'));
    expect(engRes.status).toBe(200);
    const engBody = await engRes.json();
    expect(engBody.users).toHaveLength(1);
    expect(engBody.users[0].id).toBe('u1');

    const salesRes = await GET(makeRequest('/api/pulse/admin/users?dept=Sales'));
    expect(salesRes.status).toBe(200);
    const salesBody = await salesRes.json();
    expect(salesBody.users).toHaveLength(1);
    expect(salesBody.users[0].id).toBe('u2');

    // ── Dept-filter miss: a department nobody is in → empty, still 200. ──
    const missRes = await GET(makeRequest('/api/pulse/admin/users?dept=Nonexistent'));
    expect(missRes.status).toBe(200);
    expect((await missRes.json()).users).toHaveLength(0);
  } finally {
    await cleanup();
  }
}

describe('pulse admin users route (postgres)', () => {
  it(
    'returns dept-scoped user lists with no untyped-null-param 500 on real postgres',
    async () => {
      await runSpec();
    },
    180_000,
  );
});
