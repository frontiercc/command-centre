// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The sample data's GitHub tool split (scripts/demo/github-tool-split.cjs):
// fills the migration-0047 columns from the sample's own Claude Code and
// Codex commits, adding up to each row's commit total.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

const require_ = createRequire(import.meta.url);
const { fillGithubToolSplit } = require_('../scripts/demo/github-tool-split.cjs') as {
  fillGithubToolSplit: (db: { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }, opts?: { write?: boolean }) =>
    Promise<{ claude: number; codex: number; none: number; rows: number }>;
};

let sql: TestSql;
let pool: import('pg').Pool;
let cleanup: () => Promise<void>;
const NOW = Math.floor(Date.now() / 1000);
const day = (n: number) => new Date((NOW - n * 86400) * 1000).toISOString().slice(0, 10);

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql; cleanup = t.cleanup;
  pool = (t.client as unknown as { $client: import('pg').Pool }).$client;
});
afterAll(async () => cleanup());

describe('sample GitHub tool split', () => {
  it('matches each person\'s GitHub commits to their tool commits on the nearest day and adds up to the totals', async () => {
    await sql.run(`INSERT INTO users (id, email) VALUES ('u1', 'u1@example.com'), ('u2', 'u2@example.com')`);
    await sql.run(`INSERT INTO github_repo_stats (repo, date, commit_count, prs_merged, synced_at) VALUES ('r', ?, 5, 0, ?)`, [day(2), NOW]);
    await sql.run(
      `INSERT INTO github_user_repo_stats (user_id, repo, date, commit_count, synced_at) VALUES ('u1', 'r', ?, 2, ?), ('u2', 'r', ?, 2, ?)`,
      [day(2), NOW, day(2), NOW]);
    // u1: two Claude Code commits a day earlier; u2: one Codex commit the same day, and one ten days away (too far).
    await sql.run(`INSERT INTO code_assistant_meta (id, user_id, session_id, occurred_at, commit_count) VALUES ('c1', 'u1', 's', ?, 2)`, [NOW - 3 * 86400]);
    await sql.run(`INSERT INTO codex_actions (id, user_id, session_id, commit_count, occurred_at) VALUES ('x1', 'u2', 's', 1, ?), ('x2', 'u2', 's', 1, ?)`,
      [NOW - 2 * 86400, NOW - 12 * 86400]);

    const dry = await fillGithubToolSplit(pool, { write: false });
    expect(dry).toEqual({ claude: 2, codex: 1, none: 2, rows: 1 });
    expect((await sql.all<{ c: number | null }>(`SELECT claude_commit_count AS c FROM github_repo_stats`))[0].c).toBeNull();

    await fillGithubToolSplit(pool);
    expect(await sql.all(`SELECT commit_count, claude_commit_count, codex_commit_count, no_tool_commit_count FROM github_repo_stats`))
      .toEqual([{ commit_count: 5, claude_commit_count: 2, codex_commit_count: 1, no_tool_commit_count: 2 }]);
    expect(await sql.all(`SELECT user_id, claude_commit_count, codex_commit_count, no_tool_commit_count FROM github_user_repo_stats ORDER BY user_id`))
      .toEqual([
        { user_id: 'u1', claude_commit_count: 2, codex_commit_count: 0, no_tool_commit_count: 0 },
        { user_id: 'u2', claude_commit_count: 0, codex_commit_count: 1, no_tool_commit_count: 1 },
      ]);
  });
});
