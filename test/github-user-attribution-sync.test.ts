// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Per-user GitHub attribution in the sync itself. Exercises
// runGithubSync()'s new author-resolution path: identity map → case-
// insensitive users.email match → unmatched queue, on top of the existing
// (byte-identical) github_repo_stats write path. Mocks `fetch` — never hits
// the real GitHub API. DB setup/teardown idiom copied from
// test/code-pulse-derived-pg.test.ts (createTestDbClient('postgres') on a
// migrated database; schema resolves at module-load time, so the modules
// under test must be dynamic-imported AFTER the DB env is set).
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';

function mockFetchSequence(responses: Array<{ ok: boolean; json: unknown; linkHeader?: string }>) {
  let call = 0;
  return async () => {
    const r = responses[Math.min(call, responses.length - 1)];
    call++;
    return {
      ok: r.ok,
      status: r.ok ? 200 : 500,
      headers: { get: (name: string) => (name.toLowerCase() === 'link' ? (r.linkHeader ?? null) : null) },
      json: async () => r.json,
    };
  };
}

// Commit dates are anchored RELATIVE TO NOW, never hardcoded. runGithubSync
// rewrites its window by deleting rows dated within SYNC_WINDOW_DAYS (35) of
// today before re-inserting — so a fixture pinned to a fixed calendar date
// silently stops exercising the rewrite once that date ages past the window.
// This file was pinned to a date in early August and began failing in CI 35
// days later with no code change: the "stale row is wiped" assertion was
// checking a row the sync no longer had any reason to touch.
const DAY_MS = 24 * 3600 * 1000;
function daysAgoUtc(n: number): string {
  return new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);
}
/** Well inside the 35-day sync window, and never today (a run near midnight UTC could roll over). */
const D0 = daysAgoUtc(2);
const D1 = daysAgoUtc(3);

const ORG_A_COMMITS = [
  { commit: { committer: { date: `${D0}T10:00:00Z` }, author: { email: 'sam@example.com' } }, author: { login: 'SamGH' } },
  { commit: { committer: { date: `${D0}T11:00:00Z` }, author: { email: '7+samdev@users.noreply.github.com' } }, author: null },
  { commit: { committer: { date: `${D0}T12:00:00Z` }, author: { email: 'ghost@nowhere.dev' } }, author: { login: 'GhostDev' } },
  { commit: { committer: { date: `${D1}T09:00:00Z` }, author: { email: 'sam@example.com' } }, author: null },
];

async function setupFixture() {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');

  const { schema } = await import('@/lib/db/schema');
  const githubSync = await import('@/lib/pulse/code/github-sync');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = client as any;

  await db.insert(schema.users).values([
    { id: 'u-alex', email: 'Sam@Example.com' },
    { id: 'u-sam', email: 'sam@test.local' },
  ]);
  await db.insert(schema.githubIdentityMap).values({ identity: 'login:samdev', user_id: 'u-sam' });
  await db.insert(schema.githubRepoMap).values([
    { repo: 'org/a', github_repo: 'org/a' },
    { repo: 'org/b', github_repo: 'org/b' },
  ]);

  return { client, cleanup, schema, githubSync };
}

function installFetchMock() {
  const originalFetch = global.fetch;
  global.fetch = mockFetchSequence([
    { ok: true, json: ORG_A_COMMITS },           // org/a commits page 1
    { ok: true, json: [] },                       // org/a PRs (empty)
    { ok: false, json: null },                    // org/b commits (failure isolation)
  ]) as unknown as typeof fetch;
  return originalFetch;
}

describe('runGithubSync — per-user attribution (postgres)', () => {
  it('resolves commit authors to users, queues unmatched authors, and leaves repo totals unchanged', async () => {
    const { cleanup, schema, githubSync } = await setupFixture();
    const { getTypedClient } = await import('@/lib/db/client');
    const client = await getTypedClient();

    const originalFetch = installFetchMock();
    try {
      const result = await githubSync.runGithubSync();

      // 5. Failure isolation.
      expect(result).toEqual({ synced: 1, failed: 1, errors: ['org/b commits: HTTP 500'] });

      // 1. Email match (case-insensitive).
      const alexRows = await client.select().from(schema.githubUserRepoStats)
        .where(eq(schema.githubUserRepoStats.user_id, 'u-alex'));
      const alexByDate = new Map(alexRows.map((r: { date: string; commit_count: number }) => [r.date, r.commit_count]));
      expect(alexByDate.get(D0)).toBe(1);
      expect(alexByDate.get(D1)).toBe(1);

      // 2. Manual mapping via noreply login.
      const samRows = await client.select().from(schema.githubUserRepoStats)
        .where(eq(schema.githubUserRepoStats.user_id, 'u-sam'));
      expect(samRows).toEqual([
        expect.objectContaining({ user_id: 'u-sam', repo: 'org/a', date: D0, commit_count: 1 }),
      ]);

      // 3. Unmatched queue.
      const unmatched = await client.select().from(schema.githubUnmatchedAuthors);
      expect(unmatched).toHaveLength(1);
      expect(unmatched[0]).toEqual(expect.objectContaining({ identity: 'login:ghostdev', commit_count: 1 }));

      // 4. Repo totals unchanged — unmatched commits still count.
      const repoRows = await client.select().from(schema.githubRepoStats);
      const repoRow = repoRows.find((r: { repo: string; date: string }) => r.repo === 'org/a' && r.date === D0);
      expect(repoRow?.commit_count).toBe(3);

      // 5. Failure isolation — no per-user rows for org/b.
      const orgBRows = await client.select().from(schema.githubUserRepoStats)
        .where(eq(schema.githubUserRepoStats.repo, 'org/b'));
      expect(orgBRows).toHaveLength(0);
    } finally {
      global.fetch = originalFetch;
      await cleanup();
    }
  });

  it('rewrites the per-user window on re-run (self-heal, no duplicates)', async () => {
    const { cleanup, schema, githubSync } = await setupFixture();
    const { getTypedClient } = await import('@/lib/db/client');
    const client = await getTypedClient();

    // Stale row from a prior sync / prior mapping state.
    await client.insert(schema.githubUserRepoStats).values({
      user_id: 'u-old', repo: 'org/a', date: D0, commit_count: 9, synced_at: Math.floor(Date.now() / 1000),
    });

    const originalFetch = installFetchMock();
    try {
      await githubSync.runGithubSync();

      const rows = await client.select().from(schema.githubUserRepoStats);
      expect(rows.some((r: { user_id: string }) => r.user_id === 'u-old')).toBe(false);

      const alexToday = rows.filter((r: { user_id: string; date: string }) => r.user_id === 'u-alex' && r.date === D0);
      expect(alexToday).toHaveLength(1);
      expect(alexToday[0].commit_count).toBe(1);
    } finally {
      global.fetch = originalFetch;
      await cleanup();
    }
  });

  it('rewrites the unmatched queue on re-run (wiped and rebuilt, not accumulated)', async () => {
    const { cleanup, schema, githubSync } = await setupFixture();
    const { getTypedClient } = await import('@/lib/db/client');
    const client = await getTypedClient();

    await client.insert(schema.githubUnmatchedAuthors).values({
      identity: 'stale@old.dev', commit_count: 99, last_synced: Math.floor(Date.now() / 1000),
    });

    const originalFetch = installFetchMock();
    try {
      await githubSync.runGithubSync();

      const rows = await client.select().from(schema.githubUnmatchedAuthors);
      expect(rows).toHaveLength(1);
      expect(rows[0].identity).toBe('login:ghostdev');
    } finally {
      global.fetch = originalFetch;
      await cleanup();
    }
  });

  it('leaves a pre-existing unmatched queue intact when every repo fails to sync', async () => {
    const { cleanup, schema, githubSync } = await setupFixture();
    const { getTypedClient } = await import('@/lib/db/client');
    const client = await getTypedClient();

    await client.insert(schema.githubUnmatchedAuthors).values({
      identity: 'stale@old.dev', commit_count: 99, last_synced: Math.floor(Date.now() / 1000),
    });

    const originalFetch = global.fetch;
    // Every repo's commit fetch fails — a total-failure sync (e.g. an
    // expired PAT) must not wipe an existing queue that still reflects the
    // last successful run.
    global.fetch = mockFetchSequence([{ ok: false, json: null }]) as unknown as typeof fetch;
    try {
      const result = await githubSync.runGithubSync();
      expect(result).toEqual({ synced: 0, failed: 2, errors: ['org/a commits: HTTP 500', 'org/b commits: HTTP 500'] });

      const rows = await client.select().from(schema.githubUnmatchedAuthors);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(expect.objectContaining({ identity: 'stale@old.dev', commit_count: 99 }));
    } finally {
      global.fetch = originalFetch;
      await cleanup();
    }
  });

  it('never queues a bot author, but the bot commit still counts in the repo total', async () => {
    const { cleanup, schema, githubSync } = await setupFixture();
    const { getTypedClient } = await import('@/lib/db/client');
    const client = await getTypedClient();

    const BOT_COMMITS = [
      { commit: { committer: { date: `${D0}T09:00:00Z` }, author: { email: 'sam@example.com' } }, author: { login: 'SamGH' } },
      { commit: { committer: { date: `${D0}T10:00:00Z` }, author: { email: null } }, author: { login: 'dependabot[bot]' } },
    ];
    const originalFetch = global.fetch;
    global.fetch = mockFetchSequence([
      { ok: true, json: BOT_COMMITS },  // org/a commits
      { ok: true, json: [] },           // org/a PRs
      { ok: true, json: [] },           // org/b commits
      { ok: true, json: [] },           // org/b PRs
    ]) as unknown as typeof fetch;
    try {
      const result = await githubSync.runGithubSync();
      expect(result).toEqual({ synced: 2, failed: 0, errors: [] });

      const unmatched = await client.select().from(schema.githubUnmatchedAuthors);
      expect(unmatched.some((u: { identity: string }) => u.identity === 'login:dependabot[bot]')).toBe(false);
      expect(unmatched).toHaveLength(0);

      // Repo total still counts the bot's commit alongside the person's.
      const repoRows = await client.select().from(schema.githubRepoStats);
      const repoRow = repoRows.find((r: { repo: string; date: string }) => r.repo === 'org/a' && r.date === D0);
      expect(repoRow?.commit_count).toBe(2);
    } finally {
      global.fetch = originalFetch;
      await cleanup();
    }
  });

  it('empties a pre-existing queue when no repos are tracked (mappings.length === 0)', async () => {
    const { cleanup, schema, githubSync } = await setupFixture();
    const { getTypedClient } = await import('@/lib/db/client');
    const client = await getTypedClient();

    await client.delete(schema.githubRepoMap);
    await client.insert(schema.githubUnmatchedAuthors).values({
      identity: 'stale@old.dev', commit_count: 5, last_synced: Math.floor(Date.now() / 1000),
    });

    try {
      const result = await githubSync.runGithubSync();
      expect(result).toEqual({ synced: 0, failed: 0, errors: [] });

      const rows = await client.select().from(schema.githubUnmatchedAuthors);
      expect(rows).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});
