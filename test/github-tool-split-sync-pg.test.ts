// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The GitHub sync's tool split (migration 0047) on Postgres: each commit is
// matched in memory to a commit the same person recorded through Claude Code
// (commit metric, else model-call commit counts) or Codex within 15 minutes,
// and only the per-day counts are stored. Mocks `fetch`; never hits GitHub.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const DAY_MS = 24 * 3600 * 1000;
const D = new Date(Date.now() - 3 * DAY_MS).toISOString().slice(0, 10);
const at = (hhmm: string) => `${D}T${hhmm}:00Z`;
const epoch = (hhmm: string) => Math.floor(Date.parse(at(hhmm)) / 1000);
const SECRET_MESSAGE = 'fix: rotate the payroll export key';

// Commits API items, with a message and SHA the sync must never read or store.
const commit = (email: string, authorTime: string, committerTime = authorTime) => ({
  sha: 'deadbeef' + authorTime.replace(':', ''),
  commit: { message: SECRET_MESSAGE, author: { email, date: at(authorTime) }, committer: { date: at(committerTime) } },
  author: null,
});

const REPO_A = [
  commit('ada@example.com', '10:00'),          // Claude Code metric at 10:07 -> Claude Code
  commit('ada@example.com', '10:30'),          // nothing within 15 min -> no AI tool
  commit('ada@example.com', '11:00', '16:00'), // rebased later; author time 11:00 matches Codex at 11:10
  commit('ben@example.com', '12:00'),          // Ben has no metric: model-call commit at 11:50 -> Claude Code
  commit('stranger@elsewhere.dev', '12:00'),   // not a person -> no AI tool
];
const REPO_B = [
  commit('ada@example.com', '10:06'),          // the 10:05 metric (closest pair first); matched across repos per person
];

function mockFetch() {
  const responses: unknown[] = [REPO_A, [], REPO_B, []];
  let call = 0;
  return (async () => {
    const json = responses[Math.min(call, responses.length - 1)];
    call++;
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => json };
  }) as unknown as typeof fetch;
}

let sql: import('./helpers/sql').TestSql;
let cleanup: () => Promise<void>;

describe('runGithubSync tool split (postgres)', () => {
  beforeAll(async () => {
    const { createTestDatabase } = await import('./helpers/db');
    const t = await createTestDatabase();
    sql = t.sql; cleanup = t.cleanup;
  }, 180_000);
  afterAll(async () => { if (cleanup) await cleanup(); });

  it('stores per-day counts made with Claude Code, with Codex and with no AI tool, adding up to the total', async () => {
    await sql.run(`INSERT INTO users (id, email) VALUES ('u-ada', 'Ada@Example.com'), ('u-ben', 'ben@example.com')`);
    await sql.run(`INSERT INTO github_repo_map (repo, github_repo, created_at) VALUES ('org/a', 'org/a', 0), ('org/b', 'org/b', 0)`);
    // A row synced before the split, outside this sync's window: stays NULL.
    await sql.run(`INSERT INTO github_repo_stats (repo, date, commit_count, prs_merged, synced_at) VALUES ('org/a', '2000-01-01', 3, 0, 0)`);
    // Ada: Claude Code commit metric at 10:05 and 10:07; Codex commit at 11:10.
    await sql.run(
      `INSERT INTO code_otel_metrics (id, user_id, metric_name, value, occurred_at) VALUES
        ('m1', 'u-ada', 'claude_code.commit.count', 1, ?), ('m2', 'u-ada', 'claude_code.commit.count', 1, ?)`,
      [epoch('10:05'), epoch('10:07')],
    );
    // Ada's model-call commit counts are ignored: she has metric rows (never both).
    await sql.run(
      `INSERT INTO code_assistant_meta (id, user_id, session_id, occurred_at, commit_count) VALUES ('cam-ada', 'u-ada', 's-a', ?, 1)`,
      [epoch('10:30')],
    );
    await sql.run(
      `INSERT INTO codex_actions (id, user_id, session_id, commit_count, occurred_at) VALUES ('ca1', 'u-ada', 'cs1', 1, ?)`,
      [epoch('11:10')],
    );
    // Ben: no metric, a model-call commit at 11:50.
    await sql.run(
      `INSERT INTO code_assistant_meta (id, user_id, session_id, occurred_at, commit_count) VALUES ('cam-ben', 'u-ben', 's-b', ?, 1)`,
      [epoch('11:50')],
    );

    const original = global.fetch;
    global.fetch = mockFetch();
    try {
      const { runGithubSync } = await import('@/lib/pulse/code/github-sync');
      const result = await runGithubSync();
      expect(result).toEqual({ synced: 2, failed: 0, errors: [] });
    } finally {
      global.fetch = original;
    }

    const repoRows = await sql.all<{ repo: string; date: string; commit_count: number; claude_commit_count: number | null; codex_commit_count: number | null; no_tool_commit_count: number | null }>(
      `SELECT repo, date, commit_count, claude_commit_count, codex_commit_count, no_tool_commit_count FROM github_repo_stats ORDER BY repo, date`,
    );
    const byKey = new Map(repoRows.map(r => [`${r.repo} ${r.date}`, r]));
    // Repo A: 5 commits on D (one committed at 16:00 after a rebase), total unchanged.
    expect(byKey.get(`org/a ${D}`)).toMatchObject({ commit_count: 5, claude_commit_count: 2, codex_commit_count: 1, no_tool_commit_count: 2 });
    // Repo B: Ada's 10:06 commit takes the 10:05 metric; the 10:07 one goes to repo A's 10:00.
    expect(byKey.get(`org/b ${D}`)).toMatchObject({ commit_count: 1, claude_commit_count: 1, codex_commit_count: 0, no_tool_commit_count: 0 });
    expect(byKey.get('org/a 2000-01-01')).toMatchObject({ commit_count: 3, claude_commit_count: null, codex_commit_count: null, no_tool_commit_count: null });
    for (const r of repoRows.filter(r => r.claude_commit_count !== null)) {
      expect(r.claude_commit_count! + r.codex_commit_count! + r.no_tool_commit_count!).toBe(r.commit_count);
    }

    const userRows = await sql.all<{ user_id: string; repo: string; commit_count: number; claude_commit_count: number; codex_commit_count: number; no_tool_commit_count: number }>(
      `SELECT user_id, repo, commit_count, claude_commit_count, codex_commit_count, no_tool_commit_count FROM github_user_repo_stats ORDER BY user_id, repo`,
    );
    expect(userRows).toEqual([
      { user_id: 'u-ada', repo: 'org/a', commit_count: 3, claude_commit_count: 1, codex_commit_count: 1, no_tool_commit_count: 1 },
      { user_id: 'u-ada', repo: 'org/b', commit_count: 1, claude_commit_count: 1, codex_commit_count: 0, no_tool_commit_count: 0 },
      { user_id: 'u-ben', repo: 'org/a', commit_count: 1, claude_commit_count: 1, codex_commit_count: 0, no_tool_commit_count: 0 },
    ]);

    // Nothing from the commit message or SHA is stored anywhere the sync writes.
    const stored = JSON.stringify([
      repoRows,
      userRows,
      await sql.all(`SELECT * FROM github_unmatched_authors`),
    ]);
    expect(stored).not.toContain('payroll');
    expect(stored).not.toContain('deadbeef');
  });

  it('a network error on one repo marks it failed and still writes the other repos', async () => {
    // Runs after the test above: org/a and org/b are mapped and org/b has a row on D.
    await sql.run(`INSERT INTO github_repo_map (repo, github_repo, created_at) VALUES ('org/c', 'org/c', 0)`);
    const urls: string[] = [];
    const original = global.fetch;
    global.fetch = (async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/repos/org/b/')) throw new TypeError('fetch failed');
      const json = url.includes('/pulls')
        ? []
        : url.includes('/repos/org/a/') ? REPO_A : [commit('ben@example.com', '09:00')];
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => json };
    }) as unknown as typeof fetch;
    const { runGithubSync } = await import('@/lib/pulse/code/github-sync');
    const result = await runGithubSync().finally(() => { global.fetch = original; });

    expect(result).toEqual({ synced: 2, failed: 1, errors: ['org/b: fetch failed'] });
    // org/c was still fetched after org/b threw.
    expect(urls.some(u => u.includes('/repos/org/c/commits'))).toBe(true);

    const rows = await sql.all<{ repo: string; date: string; commit_count: number; claude_commit_count: number | null; codex_commit_count: number | null; no_tool_commit_count: number | null }>(
      `SELECT repo, date, commit_count, claude_commit_count, codex_commit_count, no_tool_commit_count FROM github_repo_stats WHERE date = ? ORDER BY repo`, [D],
    );
    const byRepo = new Map(rows.map(r => [r.repo, r]));
    expect(byRepo.get('org/a')).toMatchObject({ commit_count: 5 });
    // Ben's 09:00 commit: his only model-call commit is at 11:50, so no AI tool.
    expect(byRepo.get('org/c')).toMatchObject({ commit_count: 1, claude_commit_count: 0, codex_commit_count: 0, no_tool_commit_count: 1 });
    // The failed repo's window is left as it was, not cleared.
    expect(byRepo.get('org/b')).toMatchObject({ commit_count: 1, claude_commit_count: 1, codex_commit_count: 0, no_tool_commit_count: 0 });
    const benC = await sql.all<{ commit_count: number }>(
      `SELECT commit_count FROM github_user_repo_stats WHERE user_id = 'u-ben' AND repo = 'org/c'`,
    );
    expect(benC).toEqual([{ commit_count: 1 }]);
  });
});
