// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Route-level coverage for the /api/pulse/code/me `githubRepos`
// field. Mirrors the auth-mock + handler-invocation idiom of
// test/github-identity-route.test.ts: getAdminSession is mocked per-test via
// a mutable sessionResult, the route handler is imported dynamically and
// invoked directly against a real getTypedClient() (same database
// the raw `sql` helper opened via createTestDatabase()).
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
const dateStr = (secondsAgo: number) => new Date((NOW - secondsAgo) * 1000).toISOString().slice(0, 10);

const TODAY = dateStr(0);
const THREE_DAYS_AGO = dateStr(3 * 24 * 3600);
const TWENTY_DAYS_AGO = dateStr(20 * 24 * 3600);

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  sessionResult = { authenticated: true, role: 'admin', userId: 'admin-1', email: 'admin@example.com', department: null };
  await sql.exec(`DELETE FROM github_user_repo_stats;
           DELETE FROM github_repo_map;
           DELETE FROM users;`);
  await sql.run(
    `INSERT INTO users (id, email, display_name) VALUES ('u1', 'u1@test.com', 'Ada')`
  );
  await sql.run(
    `INSERT INTO users (id, email, display_name) VALUES ('u2', 'u2@test.com', 'Sam')`
  );
  await sql.run(
    `INSERT INTO users (id, email, display_name) VALUES ('u3', 'u3@test.com', 'Kim')`
  );
  // Three currently-mapped repos, shared across the fixture users.
  const insertMap = (...params: unknown[]) => sql.run(
    `INSERT INTO github_repo_map (repo, github_repo, created_at) VALUES (?, ?, ?)`, params
  );
  await insertMap('org/a', 'org/a', NOW);
  await insertMap('org/b', 'org/b', NOW);
  await insertMap('org/c', 'org/c', NOW);
});

function makeRequest(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

describe('GET /api/pulse/code/me — githubRepos', () => {
  it('returns count7d + sorted names7d for repos active in the last 7 days, excluding an unmapped repo and a 20-day-old-only repo', async () => {
    const insertStats = (...params: unknown[]) => sql.run(
      `INSERT INTO github_user_repo_stats (user_id, repo, date, commit_count, synced_at) VALUES (?, ?, ?, ?, ?)`, params
    );
    // Two repos active within the last 7 days.
    await insertStats('u1', 'org/b', TODAY, 3, NOW);
    await insertStats('u1', 'org/a', THREE_DAYS_AGO, 2, NOW);
    // A third mapped repo, but only active 20 days ago — inside the 35d
    // window, outside the 7d window, so must NOT appear in names7d/count7d.
    await insertStats('u1', 'org/c', TWENTY_DAYS_AGO, 1, NOW);
    // An UNMAPPED repo active today — must be excluded entirely.
    await insertStats('u1', 'org/z', TODAY, 5, NOW);

    const route = await import('../app/api/pulse/code/me/route');
    const res = await route.GET(makeRequest('/api/pulse/code/me?userId=u1'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.githubRepos).toEqual({ count7d: 2, names7d: ['org/a', 'org/b'] });
  });

  it('returns null when the resolved user has no github_user_repo_stats rows', async () => {
    const route = await import('../app/api/pulse/code/me/route');
    const res = await route.GET(makeRequest('/api/pulse/code/me?userId=u2'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.githubRepos).toBeNull();
  });

  it('returns count7d: 0 and names7d: [] when window rows exist but none within the last 7 days', async () => {
    await sql.run(
      `INSERT INTO github_user_repo_stats (user_id, repo, date, commit_count, synced_at) VALUES (?, ?, ?, ?, ?)`, ['u3', 'org/a', TWENTY_DAYS_AGO, 4, NOW]
    );

    const route = await import('../app/api/pulse/code/me/route');
    const res = await route.GET(makeRequest('/api/pulse/code/me?userId=u3'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.githubRepos).toEqual({ count7d: 0, names7d: [] });
  });
});
