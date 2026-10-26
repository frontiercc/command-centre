// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Bug: GET /api/health calls `getAdminSession(request)` OUTSIDE the
// try/catch that guards the DB liveness probe. When the DB is down AND the
// caller is an authenticated admin (has a session cookie), getAdminSession
// itself throws (it reads the DB to validate the cookie) -> the whole GET
// handler throws -> Next returns HTTP 500 with an EMPTY body. The
// database-unavailable banner's fetch then fails `res.json()` and never
// renders, in exactly the outage scenario it exists for. This test locks in
// the fix: the health endpoint must NEVER throw, regardless of session
// validation failure.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/admin-auth', () => ({
  getAdminSession: vi.fn(async () => {
    throw new Error('DB unavailable — cannot validate session');
  }),
}));

const dbOkRef = { current: false };
const executeCalls: unknown[] = [];

vi.mock('@/lib/db/client', () => ({
  getTypedClient: vi.fn(async () => {
    if (!dbOkRef.current) {
      throw new Error('connection refused');
    }
    // Minimal stub client sufficient for the route's liveness probe + the
    // best-effort migration/agent-count reads (each independently try/caught
    // in the route, so a rejecting `.select` is fine).
    return {
      execute: async (q: unknown) => {
        executeCalls.push(q);
        return { rows: [{ ok: 1 }], rowCount: 1 };
      },
      all: () => [{ ok: 1 }],
      select: () => ({
        from: () => ({
          where: async () => {
            throw new Error('agents table not available in this stub');
          },
        }),
      }),
    };
  }),
}));

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/health');
}

beforeEach(() => {
  vi.resetModules();
  dbOkRef.current = false;
  executeCalls.length = 0;
});

describe('GET /api/health', () => {
  it('never throws when the DB is down and the caller is authenticated (banner + healthcheck must still work)', async () => {
    dbOkRef.current = false;
    const { GET } = await import('../app/api/health/route');

    const res = await GET(makeRequest());

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ status: 'degraded' });
  });

  it('falls back gracefully to a minimal ok body when session validation throws but the DB is actually up', async () => {
    dbOkRef.current = true;
    const { GET } = await import('../app/api/health/route');

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
  });

  // There is no `_migrations` table on Postgres (it uses `__drizzle_migrations`,
  // never wired up here) — querying it always throws and is caught, but the
  // server-side error log would fire on every 30s health poll regardless.
  // The route skips the query entirely instead of catching its guaranteed
  // failure.
  it('never queries _migrations on Postgres (avoids the guaranteed-fail log spam)', async () => {
    dbOkRef.current = true;
    const { GET } = await import('../app/api/health/route');

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    const queriedMigrations = executeCalls.some((q) => JSON.stringify(q).includes('_migrations'));
    expect(queriedMigrations).toBe(false);
  });
});
