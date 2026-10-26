// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Route-level coverage for the identity-mapping admin API
// (app/api/pulse/code/github/identity/route.ts). Mirrors the auth-mock +
// handler-invocation idiom of test/code-pulse-remaining-routes.test.ts:
// getAdminSession is mocked per-test via a mutable sessionResult, route
// handlers are imported dynamically and invoked directly against a real
// getTypedClient() (same database the raw `sql` helper opened).
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string; department?: string | null };
vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return {
    ...actual,
    getAdminSession: vi.fn(() => sessionResult),
  };
});

let sql: TestSql;
let cleanup: () => Promise<void>;

const NOW = Math.floor(Date.now() / 1000);

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  sessionResult = { authenticated: true, role: 'admin', userId: 'admin-1', email: 'admin@example.com', department: null };
  await sql.exec(`DELETE FROM github_identity_map;
           DELETE FROM github_unmatched_authors;
           DELETE FROM users;`);
  await sql.run(
    `INSERT INTO users (id, email, display_name) VALUES ('u1', 'u1@test.com', 'Ada')`
  );
});

function makeRequest(url: string, init?: { method?: string; body?: string }): NextRequest {
  return new NextRequest(`http://localhost${url}`, init);
}

describe('GET /api/pulse/code/github/identity', () => {
  it('401s when unauthenticated', async () => {
    sessionResult = { authenticated: false };
    const route = await import('../app/api/pulse/code/github/identity/route');
    const res = await route.GET(makeRequest('/api/pulse/code/github/identity'));
    expect(res.status).toBe(401);
  });

  it('403s for the pulse role', async () => {
    sessionResult = { authenticated: true, role: 'pulse', userId: 'u2', email: 'u2@test.com', department: null };
    const route = await import('../app/api/pulse/code/github/identity/route');
    const res = await route.GET(makeRequest('/api/pulse/code/github/identity'));
    expect(res.status).toBe(403);
  });

  it('200s for manager with mappings/unmatched arrays', async () => {
    sessionResult = { authenticated: true, role: 'manager', userId: 'm1', email: 'm1@test.com', department: null };
    await sql.run(
      `INSERT INTO github_identity_map (identity, user_id, created_at) VALUES ('u1@test.com', 'u1', ?)`, [NOW]
    );
    await sql.run(
      `INSERT INTO github_unmatched_authors (identity, commit_count, last_synced) VALUES ('login:ghost', 3, ?)`, [NOW]
    );
    const route = await import('../app/api/pulse/code/github/identity/route');
    const res = await route.GET(makeRequest('/api/pulse/code/github/identity'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.mappings)).toBe(true);
    expect(Array.isArray(data.unmatched)).toBe(true);
    expect(data.mappings).toEqual([{ identity: 'u1@test.com', user_id: 'u1', display_name: 'Ada' }]);
    expect(data.unmatched).toEqual([{ identity: 'login:ghost', commit_count: 3 }]);
  });
});

describe('POST /api/pulse/code/github/identity', () => {
  it('403s for manager — writes are admin-only', async () => {
    sessionResult = { authenticated: true, role: 'manager', userId: 'm1', email: 'm1@test.com', department: null };
    const route = await import('../app/api/pulse/code/github/identity/route');
    const res = await route.POST(makeRequest('/api/pulse/code/github/identity', {
      method: 'POST', body: JSON.stringify({ identity: 'Sam@X.com', userId: 'u1' }),
    }));
    expect(res.status).toBe(403);
  });

  it('normalises an email identity to lowercase and stores it as admin', async () => {
    const route = await import('../app/api/pulse/code/github/identity/route');
    const res = await route.POST(makeRequest('/api/pulse/code/github/identity', {
      method: 'POST', body: JSON.stringify({ identity: 'Sam@X.com', userId: 'u1' }),
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    const row = await sql.get(`SELECT identity, user_id FROM github_identity_map WHERE identity = 'sam@x.com'`) as
      | { identity: string; user_id: string }
      | undefined;
    expect(row).toBeTruthy();
    expect(row!.identity).toBe('sam@x.com');
    expect(row!.user_id).toBe('u1');
  });

  it('stores a bare login as the login:<name> form', async () => {
    const route = await import('../app/api/pulse/code/github/identity/route');
    const res = await route.POST(makeRequest('/api/pulse/code/github/identity', {
      method: 'POST', body: JSON.stringify({ identity: 'SamDev', userId: 'u1' }),
    }));
    expect(res.status).toBe(200);
    const row = await sql.get(`SELECT identity FROM github_identity_map WHERE identity = 'login:samdev'`);
    expect(row).toBeTruthy();
  });

  it('400s on an unknown userId', async () => {
    const route = await import('../app/api/pulse/code/github/identity/route');
    const res = await route.POST(makeRequest('/api/pulse/code/github/identity', {
      method: 'POST', body: JSON.stringify({ identity: 'someone@test.com', userId: 'does-not-exist' }),
    }));
    expect(res.status).toBe(400);
  });

  it('400s on an empty identity', async () => {
    const route = await import('../app/api/pulse/code/github/identity/route');
    const res = await route.POST(makeRequest('/api/pulse/code/github/identity', {
      method: 'POST', body: JSON.stringify({ identity: '', userId: 'u1' }),
    }));
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/pulse/code/github/identity', () => {
  it('removes the seeded identity as admin', async () => {
    await sql.run(
      `INSERT INTO github_identity_map (identity, user_id, created_at) VALUES ('u1@test.com', 'u1', ?)`, [NOW]
    );
    const route = await import('../app/api/pulse/code/github/identity/route');
    const res = await route.DELETE(makeRequest('/api/pulse/code/github/identity', {
      method: 'DELETE', body: JSON.stringify({ identity: 'u1@test.com' }),
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    const row = await sql.get(`SELECT identity FROM github_identity_map WHERE identity = 'u1@test.com'`);
    expect(row).toBeUndefined();
  });
});
