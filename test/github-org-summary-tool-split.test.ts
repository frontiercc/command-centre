// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// /api/pulse/code/org-summary's GitHub overlay with the tool split
// (migration 0047): the Shipping alignment series carries GitHub commits made
// with Claude Code, with Codex and with no AI tool recorded, a day synced
// before the split shows the total only, and the Codex tab gets the
// "How much of our codebase" reach from GitHub commits matched to Codex.
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
  await sql.run(`INSERT INTO users (id, email) VALUES ('u1', 'u1@example.com')`);
  // Codex data present, so the Claude / Codex tabs exist.
  await sql.run(
    `INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, occurred_at)
     VALUES ('codex:os-1', 'codex:s1', 'u1', 'code_user_message', 'code', 'codex', ?)`, [NOW]);
  await sql.run(`INSERT INTO codex_actions (id, user_id, session_id, commit_count, occurred_at) VALUES ('ca1', 'u1', 'codex:s1', 2, ?)`, [NOW - 86400]);
  await sql.run(`INSERT INTO code_assistant_meta (id, user_id, session_id, occurred_at, commit_count) VALUES ('cam1', 'u1', 's1', ?, 3)`, [NOW - 86400]);
  for (const repo of ['org/a', 'org/b', 'org/c']) {
    await sql.run(`INSERT INTO github_repo_map (repo, github_repo, created_at) VALUES (?, ?, ?)`, [repo, repo, NOW]);
  }
  const split = (...p: unknown[]) => sql.run(
    `INSERT INTO github_repo_stats (repo, date, commit_count, prs_merged, synced_at, claude_commit_count, codex_commit_count, no_tool_commit_count)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?)`, p);
  await split('org/a', day(1), 6, NOW, 3, 2, 1);
  await split('org/b', day(1), 1, NOW, 0, 0, 1);
  await split('org/c', day(20), 2, NOW, 0, 1, 1);
  // Synced before the split.
  await sql.run(`INSERT INTO github_repo_stats (repo, date, commit_count, prs_merged, synced_at) VALUES ('org/a', ?, 4, 0, ?)`, [day(10), NOW]);
});
afterAll(async () => cleanup());

const get = async (vendor: string) => {
  const route = await import('../app/api/pulse/code/org-summary/route');
  const res = await route.GET(new NextRequest(`http://localhost/api/pulse/code/org-summary?vendor=${vendor}`));
  expect(res.status).toBe(200);
  return res.json();
};

describe('org-summary GitHub overlay tool split', () => {
  it('carries the split per day, and the total only on a day synced before it', async () => {
    const data = await get('all');
    const o = data.githubOverlay;
    expect(o.toolSplit).toBe(true);
    const byDate = new Map(o.shippingSeries.map((d: { date: string }) => [d.date, d]));
    expect(byDate.get(day(1))).toMatchObject({ ghCommits: 7, ghClaude: 3, ghCodex: 2, ghNone: 2, aiCommits: 5 });
    expect(byDate.get(day(10))).toMatchObject({ ghCommits: 4, ghClaude: null, ghCodex: null, ghNone: null });
    expect(byDate.get(day(2))).toMatchObject({ ghCommits: 0, ghClaude: 0, ghCodex: 0, ghNone: 0 });
  });

  it('on the Codex tab gives the reach from GitHub commits matched to Codex', async () => {
    const data = await get('openai');
    expect(data.githubOverlay.codexReach).toEqual({ activeRepos7d: 1, quietRepos30d: 1, trackedRepos: 3 });
    const d1 = data.githubOverlay.shippingSeries.find((d: { date: string }) => d.date === day(1));
    expect(d1.aiCommits).toBe(2); // Codex's own commits only
  });

  it('on the Claude tab has no Codex reach', async () => {
    const data = await get('claude');
    expect(data.githubOverlay.codexReach).toBeNull();
    const d1 = data.githubOverlay.shippingSeries.find((d: { date: string }) => d.date === day(1));
    expect(d1.aiCommits).toBe(3);
  });

  it('with ChatGPT and Codex hidden, folds commits matched to Codex into no AI tool recorded', async () => {
    type Day = { date: string; ghCommits: number; ghClaude: number | null; ghCodex: number | null; ghNone: number | null };
    const at = (data: { githubOverlay: { shippingSeries: Day[] } }, d: string) => data.githubOverlay.shippingSeries.find(x => x.date === d)!;
    const setShown = (v: string) => sql.run(
      `INSERT INTO config (key, value) VALUES ('openai_shown', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [v]);

    // Shown: Codex keeps its own count.
    const shown = await get('all');
    expect(at(shown, day(1))).toMatchObject({ ghCommits: 7, ghClaude: 3, ghCodex: 2, ghNone: 2 });
    expect(at(shown, day(20))).toMatchObject({ ghCommits: 2, ghClaude: 0, ghCodex: 1, ghNone: 1 });

    await setShown('false');
    try {
      const hidden = await get('all');
      const d1 = at(hidden, day(1));
      expect(d1).toMatchObject({ ghCommits: 7, ghClaude: 3, ghCodex: 0, ghNone: 4 });
      expect(at(hidden, day(20))).toMatchObject({ ghCommits: 2, ghClaude: 0, ghCodex: 0, ghNone: 2 });
      // Every day with the split still adds up to its GitHub commit total.
      for (const d of hidden.githubOverlay.shippingSeries as Day[]) {
        if (d.ghClaude === null) continue;
        expect(d.ghClaude + d.ghCodex! + d.ghNone!).toBe(d.ghCommits);
      }
      // A day synced before the split stays not measured.
      expect(at(hidden, day(10))).toMatchObject({ ghCommits: 4, ghClaude: null, ghCodex: null, ghNone: null });
      expect(hidden.githubOverlay.codexReach).toBeNull();
    } finally {
      await setShown('true');
    }
  });
});
