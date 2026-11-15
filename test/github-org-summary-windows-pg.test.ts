// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// /api/pulse/code/org-summary's GitHub volume figures cover exactly the last 7
// and 30 days, and only tracked (mapped) repos, the same as the repo cards: a
// row from 7 or 30 days ago, or from a repo no longer tracked, is left out.
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
  await sql.run(`INSERT INTO github_repo_map (repo, github_repo, created_at) VALUES ('org/a', 'org/a', ?)`, [NOW]);
  const stat = (repo: string, d: string, commits: number, prs: number) => sql.run(
    `INSERT INTO github_repo_stats (repo, date, commit_count, prs_merged, synced_at) VALUES (?, ?, ?, ?, ?)`, [repo, d, commits, prs, NOW]);
  await stat('org/a', day(0), 1, 1);
  await stat('org/a', day(6), 2, 0);
  await stat('org/a', day(7), 4, 1);   // eighth day back: not in the last 7
  await stat('org/a', day(29), 8, 0);
  await stat('org/a', day(30), 16, 0); // 31st day back: not in the last 30
  await stat('org/x', day(1), 32, 1);  // not tracked
});
afterAll(async () => cleanup());

describe('org-summary GitHub volume windows', () => {
  it('counts exactly 7 and 30 days of tracked repos, matching the repo cards', async () => {
    const route = await import('../app/api/pulse/code/org-summary/route');
    const res = await route.GET(new NextRequest('http://localhost/api/pulse/code/org-summary?vendor=all'));
    expect(res.status).toBe(200);
    const o = (await res.json()).githubOverlay;
    expect(o.totalCommits7d).toBe(3);
    expect(o.totalPrs7d).toBe(1);
    expect(o.totalCommits30dByRepo).toEqual({ 'org/a': 15 });
    const card = o.repoCards.find((c: { repo: string }) => c.repo === 'org/a');
    expect(card.commits7d).toBe(o.totalCommits7d);
    expect(card.commits30d).toBe(15);
  });
});
