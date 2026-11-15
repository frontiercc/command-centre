// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// /api/pulse/code/org-summary's active-repository count over 30 days, the
// window the rest of Developer Pulse uses: a tracked repo with a GitHub commit
// 20 days ago counts, one whose last commit was 40 days ago does not. The
// 7-day count beside it stays as it was.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return {
    ...actual,
    getAdminSession: vi.fn(() => ({ authenticated: true, role: 'admin', userId: 'admin-1', email: 'admin@example.com', department: null })),
  };
});

let sql: TestSql;
let cleanup: () => Promise<void>;
const NOW = Math.floor(Date.now() / 1000);
const day = (n: number) => new Date((NOW - n * 86400) * 1000).toISOString().slice(0, 10);

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql; cleanup = t.cleanup;
  for (const repo of ['org/recent', 'org/twenty', 'org/forty']) {
    await sql.run(`INSERT INTO github_repo_map (repo, github_repo, created_at) VALUES (?, ?, ?)`, [repo, repo, NOW]);
  }
  const stat = (repo: string, d: string, commits: number) => sql.run(
    `INSERT INTO github_repo_stats (repo, date, commit_count, prs_merged, synced_at) VALUES (?, ?, ?, 0, ?)`, [repo, d, commits, NOW]);
  await stat('org/recent', day(2), 1);  // in the last 7 and the last 30 days
  await stat('org/twenty', day(20), 3); // in the last 30 days only
  await stat('org/forty', day(40), 5);  // outside the 30 days
});
afterAll(async () => cleanup());

describe('org-summary repositories active over 30 days', () => {
  it('counts a repo active 20 days ago and leaves out one active 40 days ago', async () => {
    const route = await import('../app/api/pulse/code/org-summary/route');
    const res = await route.GET(new NextRequest('http://localhost/api/pulse/code/org-summary?vendor=all'));
    expect(res.status).toBe(200);
    const o = (await res.json()).githubOverlay;
    expect(o.reposActive30d).toBe(2);
    expect(o.reposActive7d).toBe(1);
  });
});
