// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Focused test for the /api/pulse/person/[userId] route handler
// after converting its 2 inline `.prepare()` reads (RBAC dept-scope check) to
// async Drizzle. getPerson360() itself is already converted and covered by
// test/pulse-person.test.ts / test/pulse-granularity-readers.test.ts — this
// test only proves the route's OWN dept-scope gate queries work (simple
// selects, no aggregates/date-buckets/jsonb). Runs on Postgres.
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';

let mockSession: { authenticated: boolean; role?: string; department?: string | null } = {
  authenticated: true,
  role: 'admin',
};

vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return {
    ...actual,
    getAdminSession: async () => mockSession,
  };
});

// FinOps on, so canSeeSpendReview follows the person-level rule alone.
vi.mock('@/lib/config', async (orig) => {
  const actual = await orig<typeof import('@/lib/config')>();
  return { ...actual, getAllConfig: async () => ({ ...(await actual.getAllConfig().catch(() => ({}))), chargebackEnabled: true }) };
});

vi.mock('@/lib/pulse/person', () => ({
  getPerson360: vi.fn(async (userId: string) => ({ userId, mocked: true })),
}));

function makeRequest(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

beforeEach(() => {
  mockSession = { authenticated: true, role: 'admin' };
});

describe('GET /api/pulse/person/[userId]', () => {
  it('returns 401 when not authenticated', async () => {
    mockSession = { authenticated: false };
    const { GET } = await import('../app/api/pulse/person/[userId]/route');
    const res = await GET(makeRequest('/api/pulse/person/u1'), { params: Promise.resolve({ userId: 'u1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 403 for a role that fails canAccessCoworkPulse (e.g. code)', async () => {
    mockSession = { authenticated: true, role: 'code' };
    const { GET } = await import('../app/api/pulse/person/[userId]/route');
    const res = await GET(makeRequest('/api/pulse/person/u1'), { params: Promise.resolve({ userId: 'u1' }) });
    expect(res.status).toBe(403);
  });

  it('returns 422 for a dept-scoped role (pulse) with no department assigned', async () => {
    mockSession = { authenticated: true, role: 'pulse', department: null };
    const { GET } = await import('../app/api/pulse/person/[userId]/route');
    const res = await GET(makeRequest('/api/pulse/person/u1'), { params: Promise.resolve({ userId: 'u1' }) });
    expect(res.status).toBe(422);
  });

  it('admin bypasses the dept-scope check and reaches getPerson360', async () => {
    mockSession = { authenticated: true, role: 'admin' };
    const { GET } = await import('../app/api/pulse/person/[userId]/route');
    const res = await GET(makeRequest('/api/pulse/person/u1'), { params: Promise.resolve({ userId: 'u1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Admins get person-level human time (null figures here: the feature is off).
    expect(body).toEqual({ userId: 'u1', mocked: true, humanTime: { cowork: null, code: null }, canSeeSpendReview: true });
  });

  // Both dept-scope DB-backed cases share ONE createTestDatabase() call,
  // seeded once. Different user ids (u1 / u2) keep the two cases independent
  // within the shared DB.
  describe('dept-scope DB-backed cases', () => {
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
      const h = await createTestDatabase();
      cleanup = h.cleanup;
      const { getTypedClient } = await import('@/lib/db/client');
      const { schema } = await import('@/lib/db/schema');
      const client = await getTypedClient();

      await client.insert(schema.users).values([
        { id: 'u1', email: 'u1@test.com', display_name: 'Ada' },
        { id: 'u2', email: 'u2@test.com', display_name: 'Grace' },
      ]);
      await client.insert(schema.adminUsers).values([
        { id: 'admin-target', email: 'target@test.com', password_hash: 'x', role: 'viewer', linked_cowork_user_id: 'u1', department: 'Engineering' },
        { id: 'admin-target2', email: 'target2@test.com', password_hash: 'x', role: 'viewer', linked_cowork_user_id: 'u2', department: 'Sales' },
      ]);
    });

    afterAll(async () => cleanup());

    it('dept-scoped role viewing a same-department user (resolved via admin_users.linked_cowork_user_id) succeeds', async () => {
      mockSession = { authenticated: true, role: 'pulse', department: 'Engineering' };
      const { GET } = await import('../app/api/pulse/person/[userId]/route');
      const res = await GET(makeRequest('/api/pulse/person/u1'), { params: Promise.resolve({ userId: 'u1' }) });
      expect(res.status).toBe(200);
      const body = await res.json();
      // A colleague in the same department never gets another person's human time.
      expect(body).toEqual({ userId: 'u1', mocked: true, humanTime: null, canSeeSpendReview: false });
    });

    it('dept-scoped role viewing a DIFFERENT department user is forbidden', async () => {
      mockSession = { authenticated: true, role: 'pulse', department: 'Engineering' };
      const { GET } = await import('../app/api/pulse/person/[userId]/route');
      const res = await GET(makeRequest('/api/pulse/person/u2'), { params: Promise.resolve({ userId: 'u2' }) });
      expect(res.status).toBe(403);
    });
  });
});
