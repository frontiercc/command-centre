// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Route-level coverage for the /api/pulse/code/dept/[dept]
// `githubRepos` field + per-member `github_repo_count`. Mirrors the
// auth-mock + handler-invocation idiom of
// test/github-me-payload.test.ts: getAdminSession is mocked per-test via a
// mutable sessionResult, the route handler is imported dynamically and
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
  // Member A and Member B both in Engineering; Member C is in a different
  // department and must not affect Engineering's dept-wide count.
  await sql.run(
    `INSERT INTO users (id, email, display_name, department) VALUES ('u1', 'u1@test.com', 'Ada', 'Engineering')`
  );
  await sql.run(
    `INSERT INTO users (id, email, display_name, department) VALUES ('u2', 'u2@test.com', 'Sam', 'Engineering')`
  );
  await sql.run(
    `INSERT INTO users (id, email, display_name, department) VALUES ('u3', 'u3@test.com', 'Kim', 'Sales')`
  );
  // Two currently-mapped repos.
  const insertMap = (...params: unknown[]) => sql.run(
    `INSERT INTO github_repo_map (repo, github_repo, created_at) VALUES (?, ?, ?)`, params
  );
  await insertMap('org/a', 'org/a', NOW);
  await insertMap('org/b', 'org/b', NOW);
});

function makeRequest(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

describe('GET /api/pulse/code/dept/[dept] — githubRepos', () => {
  it('returns dept-wide count7d + per-member github_repo_count, excluding an unmapped repo', async () => {
    const insertStats = (...params: unknown[]) => sql.run(
      `INSERT INTO github_user_repo_stats (user_id, repo, date, commit_count, synced_at) VALUES (?, ?, ?, ?, ?)`, params
    );
    // Member A active in two mapped repos within 7d.
    await insertStats('u1', 'org/a', TODAY, 3, NOW);
    await insertStats('u1', 'org/b', THREE_DAYS_AGO, 2, NOW);
    // An unmapped repo for member A, active today — must be excluded entirely
    // from both the member count and the dept-wide set.
    await insertStats('u1', 'org/z', TODAY, 4, NOW);
    // A mapped repo, but only active 20 days ago — outside the 7d window.
    await insertStats('u1', 'org/a', TWENTY_DAYS_AGO, 1, NOW);
    // Member B (same dept) has no recent GitHub activity.
    // Member C (different dept) is active, but must not count toward
    // Engineering's dept-wide total — proven by the count7d assertion below.
    await insertStats('u3', 'org/a', TODAY, 5, NOW);

    const route = await import('../app/api/pulse/code/dept/[dept]/route');
    const res = await route.GET(makeRequest('/api/pulse/code/dept/Engineering'), {
      params: Promise.resolve({ dept: 'Engineering' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.githubRepos).toEqual({ count7d: 2, names7d: ['org/a', 'org/b'], basis: 'all' });

    const memberA = data.members.find((m: { user_id: string }) => m.user_id === 'u1');
    const memberB = data.members.find((m: { user_id: string }) => m.user_id === 'u2');
    expect(memberA.github_repo_count).toBe(2);
    expect(memberB.github_repo_count).toBe(0);
  });

  it('returns githubRepos: null and members without github_repo_count when no repos are mapped', async () => {
    const route = await import('../app/api/pulse/code/dept/[dept]/route');
    // No mapped repos inserted this test — DELETE in beforeEach clears them,
    // and this test intentionally skips the insertMap calls.
    await sql.exec(`DELETE FROM github_repo_map;`);
    const res = await route.GET(makeRequest('/api/pulse/code/dept/Engineering'), {
      params: Promise.resolve({ dept: 'Engineering' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.githubRepos).toBeNull();
    const memberA = data.members.find((m: { user_id: string }) => m.user_id === 'u1');
    expect(memberA.github_repo_count).toBeUndefined();
  });

  it('returns count7d: 0 (not null) when the dept has 35d-window activity but none in the last 7 days', async () => {
    const insertStats = (...params: unknown[]) => sql.run(
      `INSERT INTO github_user_repo_stats (user_id, repo, date, commit_count, synced_at) VALUES (?, ?, ?, ?, ?)`, params
    );
    // Member A was active 20 days ago (within the 35d window) but not in the
    // last 7 — this must read as a measured zero, not "Not captured".
    await insertStats('u1', 'org/a', TWENTY_DAYS_AGO, 3, NOW);

    const route = await import('../app/api/pulse/code/dept/[dept]/route');
    const res = await route.GET(makeRequest('/api/pulse/code/dept/Engineering'), {
      params: Promise.resolve({ dept: 'Engineering' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.githubRepos).toEqual({ count7d: 0, names7d: [], basis: 'all' });

    const memberA = data.members.find((m: { user_id: string }) => m.user_id === 'u1');
    const memberB = data.members.find((m: { user_id: string }) => m.user_id === 'u2');
    expect(memberA.github_repo_count).toBe(0);
    expect(memberB.github_repo_count).toBe(0);
  });

  it('on the Codex tab counts only repos with commits matched to Codex, dept-wide and per member', async () => {
    await sql.run(
      `INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, occurred_at)
       VALUES ('codex:gh-dept-1', 'codex:s1', 'u1', 'code_user_message', 'code', 'codex', ?) ON CONFLICT DO NOTHING`, [NOW]
    );
    const insertSplit = (...params: unknown[]) => sql.run(
      `INSERT INTO github_user_repo_stats (user_id, repo, date, commit_count, synced_at, claude_commit_count, codex_commit_count, no_tool_commit_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, params
    );
    await insertSplit('u1', 'org/a', TODAY, 3, NOW, 3, 0, 0);
    await insertSplit('u2', 'org/b', THREE_DAYS_AGO, 2, NOW, 0, 2, 0);
    try {
      const route = await import('../app/api/pulse/code/dept/[dept]/route');
      const read = async (vendor: string) => (await route.GET(makeRequest(`/api/pulse/code/dept/Engineering?vendor=${vendor}`), {
        params: Promise.resolve({ dept: 'Engineering' }),
      })).json();
      const codex = await read('openai');
      expect(codex.githubRepos).toEqual({ count7d: 1, names7d: ['org/b'], basis: 'openai' });
      const count = (d: { members: Array<{ user_id: string; github_repo_count?: number }> }, id: string) =>
        d.members.find(m => m.user_id === id)?.github_repo_count;
      expect(count(codex, 'u1')).toBe(0);
      expect(count(codex, 'u2')).toBe(1);
      const claude = await read('claude');
      expect(claude.githubRepos).toEqual({ count7d: 1, names7d: ['org/a'], basis: 'claude' });
      const all = await read('all');
      expect(all.githubRepos).toEqual({ count7d: 2, names7d: ['org/a', 'org/b'], basis: 'all' });
    } finally {
      await sql.exec(`DELETE FROM cowork_messages WHERE id = 'codex:gh-dept-1'`);
    }
  });

  it('on the tool tabs, rows synced before the tool split leave the card and member counts not measured', async () => {
    await sql.run(
      `INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, occurred_at)
       VALUES ('codex:gh-dept-2', 'codex:s2', 'u1', 'code_user_message', 'code', 'codex', ?) ON CONFLICT DO NOTHING`, [NOW]
    );
    const insertStats = (...params: unknown[]) => sql.run(
      `INSERT INTO github_user_repo_stats (user_id, repo, date, commit_count, synced_at) VALUES (?, ?, ?, ?, ?)`, params
    );
    // Recent days synced before the split; an older day (inside 35, outside 7) with it.
    await insertStats('u1', 'org/a', TODAY, 3, NOW);
    await insertStats('u2', 'org/b', THREE_DAYS_AGO, 2, NOW);
    await sql.run(
      `INSERT INTO github_user_repo_stats (user_id, repo, date, commit_count, synced_at, claude_commit_count, codex_commit_count, no_tool_commit_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, ['u1', 'org/b', TWENTY_DAYS_AGO, 2, NOW, 1, 1, 0]
    );
    try {
      const route = await import('../app/api/pulse/code/dept/[dept]/route');
      const read = async (vendor: string) => (await route.GET(makeRequest(`/api/pulse/code/dept/Engineering?vendor=${vendor}`), {
        params: Promise.resolve({ dept: 'Engineering' }),
      })).json();
      const count = (d: { members: Array<{ user_id: string; github_repo_count?: number }> }, id: string) =>
        d.members.find(m => m.user_id === id)?.github_repo_count;
      for (const vendor of ['claude', 'openai']) {
        const d = await read(vendor);
        expect(d.githubRepos).toBeNull();
        expect(count(d, 'u1')).toBeUndefined();
        expect(count(d, 'u2')).toBeUndefined();
      }
      const all = await read('all');
      expect(all.githubRepos).toEqual({ count7d: 2, names7d: ['org/a', 'org/b'], basis: 'all' });
      expect(count(all, 'u1')).toBe(1);
      expect(count(all, 'u2')).toBe(1);
    } finally {
      await sql.exec(`DELETE FROM cowork_messages WHERE id = 'codex:gh-dept-2'`);
    }
  });

  it('on the tool tabs, a recent row matched to no tool is a measured 0', async () => {
    await sql.run(
      `INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, occurred_at)
       VALUES ('codex:gh-dept-3', 'codex:s3', 'u1', 'code_user_message', 'code', 'codex', ?) ON CONFLICT DO NOTHING`, [NOW]
    );
    await sql.run(
      `INSERT INTO github_user_repo_stats (user_id, repo, date, commit_count, synced_at, claude_commit_count, codex_commit_count, no_tool_commit_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, ['u1', 'org/a', THREE_DAYS_AGO, 2, NOW, 0, 0, 2]
    );
    try {
      const route = await import('../app/api/pulse/code/dept/[dept]/route');
      const codex = await (await route.GET(makeRequest('/api/pulse/code/dept/Engineering?vendor=openai'), {
        params: Promise.resolve({ dept: 'Engineering' }),
      })).json();
      expect(codex.githubRepos).toEqual({ count7d: 0, names7d: [], basis: 'openai' });
      const memberA = codex.members.find((m: { user_id: string }) => m.user_id === 'u1');
      expect(memberA.github_repo_count).toBe(0);
    } finally {
      await sql.exec(`DELETE FROM cowork_messages WHERE id = 'codex:gh-dept-3'`);
    }
  });
});
