// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * GitHub overlay sync — repo shipping volume + per-user attribution.
 *
 * Repo level: daily commit and merged-PR counts per repo
 * (github_repo_stats). Per-user level (REVISED DECISION):
 * each commit's author (already present in the same API response) is resolved
 * via the admin identity map, then a case-insensitive users.email match, into
 * per-user DAILY COUNTS (github_user_repo_stats). Unresolved authors land in
 * github_unmatched_authors — an admin-only queue, wiped and rewritten every
 * sync, capped at UNMATCHED_CAP rows. What is NEVER stored: commit SHAs,
 * messages, per-commit rows, or GitHub display names. The full sync window is
 * rewritten every run, so adding a mapping re-attributes the whole window on
 * the next sync.
 *
 * Works unauthenticated for public repos (60 req/h); set `github_token`
 * (read-only fine-grained PAT) for private repos and normal rate limits.
 * Tests MOCK `fetch` — never hit the network.
 */
import { and, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue, setConfigValue } from '@/lib/config';
import { identityCandidates, bestUnmatchedIdentity, type CommitAuthor } from '@/lib/pulse/code/github-identity';

const SYNC_WINDOW_DAYS = 35;   // covers the 30-day UI windows with margin
const MAX_PAGES = 5;           // 500 commits per repo per sync — log if truncated
const UNMATCHED_CAP = 50;

export interface RepoMapping {
  repo: string;
  github_repo: string;
}

export function isValidGithubRepo(value: string): boolean {
  return /^[\w.-]+\/[\w.-]+$/.test(value);
}

/** Bucket ISO timestamps into UTC YYYY-MM-DD counts. Exported for tests. */
export function bucketByUtcDate(timestamps: string[]): Map<string, number> {
  const buckets = new Map<string, number>();
  for (const ts of timestamps) {
    const d = new Date(ts);
    if (isNaN(d.getTime())) continue;
    const key = d.toISOString().slice(0, 10);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return buckets;
}

async function githubGet(path: string, token: string): Promise<{ ok: boolean; status: number; json: unknown; linkNext: boolean }> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ccc-code-pulse',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const linkNext = (res.headers.get('link') ?? '').includes('rel="next"');
  let json: unknown = null;
  try { json = await res.json(); } catch { /* non-JSON error body */ }
  return { ok: res.ok, status: res.status, json, linkNext };
}

interface CommitDatum { date: string; email: string | null; login: string | null }

async function fetchCommitData(githubRepo: string, sinceIso: string, token: string, errors: string[]): Promise<CommitDatum[] | null> {
  const out: CommitDatum[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await githubGet(
      `/repos/${githubRepo}/commits?since=${encodeURIComponent(sinceIso)}&per_page=100&page=${page}`,
      token,
    );
    if (!r.ok) {
      console.error(`[GithubSync] ${githubRepo} commits fetch failed: HTTP ${r.status}`);
      errors.push(`${githubRepo} commits: HTTP ${r.status}`);
      return null;
    }
    const items = Array.isArray(r.json)
      ? r.json as Array<{ commit?: { committer?: { date?: string }; author?: { email?: string } }; author?: { login?: string } | null }>
      : [];
    for (const c of items) {
      if (c.commit?.committer?.date) {
        out.push({
          date: c.commit.committer.date,
          email: c.commit.author?.email ?? null,
          login: c.author?.login ?? null,
        });
      }
    }
    if (items.length < 100 || !r.linkNext) return out;
  }
  console.log(`[GithubSync] ${githubRepo}: commit list truncated at ${MAX_PAGES * 100}; counts for the window are a floor, not exact`);
  return out;
}

async function fetchMergedPrDates(githubRepo: string, sinceIso: string, token: string, errors: string[]): Promise<string[] | null> {
  // One page of most-recently-updated closed PRs is sufficient at this cadence
  const r = await githubGet(
    `/repos/${githubRepo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`,
    token,
  );
  if (!r.ok) {
    console.error(`[GithubSync] ${githubRepo} PR fetch failed: HTTP ${r.status}`);
    errors.push(`${githubRepo} pull requests: HTTP ${r.status}`);
    return null;
  }
  const since = new Date(sinceIso).getTime();
  const items = Array.isArray(r.json) ? r.json as Array<{ merged_at: string | null }> : [];
  return items
    .filter(p => p.merged_at && new Date(p.merged_at).getTime() >= since)
    .map(p => p.merged_at!);
}

export async function getMappings(): Promise<RepoMapping[]> {
  const client = await getTypedClient();
  const t = schema.githubRepoMap;
  return client
    .select({ repo: t.repo, github_repo: t.github_repo })
    .from(t)
    .orderBy(t.repo);
}

/** Bots can never be mapped to a person: skip queueing them in the
 * unmatched-author queue (their commits still count in github_repo_stats —
 * repo-level totals are untouched). Matches on the FINAL identity string
 * (login:<name> preferred by bestUnmatchedIdentity, else the raw email) so
 * both a bot's real login account and its noreply-only commits are caught. */
function isBotIdentity(identity: string): boolean {
  const lower = identity.toLowerCase();
  return (lower.startsWith('login:') && lower.endsWith('[bot]')) ||
    lower.includes('[bot]@users.noreply.github.com');
}

/**
 * `errors` lists every GitHub call that failed ("owner/repo commits: HTTP 401").
 * The scheduler records a non-empty list as a job failure —
 * a rejected token used to log and still count as a successful run.
 */
export async function runGithubSync(): Promise<{ synced: number; failed: number; errors: string[] }> {
  const mappings = await getMappings();
  if (mappings.length === 0) {
    // Untracked-everything instance: don't leave a stale queue forever.
    const client = await getTypedClient();
    await client.delete(schema.githubUnmatchedAuthors);
    return { synced: 0, failed: 0, errors: [] };
  }

  const token = await getConfigValue('githubToken');
  const client = await getTypedClient();
  const now = Math.floor(Date.now() / 1000);
  const sinceIso = new Date(Date.now() - SYNC_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
  const sinceDateStr = sinceIso.slice(0, 10);
  const t = schema.githubRepoStats;

  const gim = schema.githubIdentityMap;
  const gua = schema.githubUnmatchedAuthors;
  const gurs = schema.githubUserRepoStats;
  const usr = schema.users;

  const identityRows = await client.select({ identity: gim.identity, user_id: gim.user_id }).from(gim);
  const identityToUser = new Map(identityRows.map(r => [r.identity, r.user_id]));
  const userRows = await client.select({ id: usr.id, email: usr.email }).from(usr).where(isNotNull(usr.email));
  const emailToUser = new Map(userRows.map(r => [String(r.email).toLowerCase(), r.id]));

  const resolveAuthor = (a: CommitAuthor): string | null => {
    for (const candidate of identityCandidates(a)) {
      const mapped = identityToUser.get(candidate);
      if (mapped) return mapped;
    }
    const email = a.email?.trim().toLowerCase();
    return (email && emailToUser.get(email)) || null;
  };

  const unmatchedCounts = new Map<string, number>();

  let synced = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const m of mappings) {
    const commitData = await fetchCommitData(m.github_repo, sinceIso, token, errors);
    if (commitData === null) { failed++; continue; }
    const commitDates = commitData.map(c => c.date);
    const prDates = (await fetchMergedPrDates(m.github_repo, sinceIso, token, errors)) ?? [];

    const commits = bucketByUtcDate(commitDates);
    const prs = bucketByUtcDate(prDates);
    const allDates = new Set([...commits.keys(), ...prs.keys()]);

    // Full-window refresh: clear then rewrite so force-pushed/removed history
    // doesn't leave stale counts behind
    await client.delete(t).where(and(eq(t.repo, m.repo), gte(t.date, sinceDateStr)));
    for (const date of allDates) {
      await client
        .insert(t)
        .values({
          repo: m.repo,
          date,
          commit_count: commits.get(date) ?? 0,
          prs_merged: prs.get(date) ?? 0,
          synced_at: now,
        })
        .onConflictDoUpdate({
          target: [t.repo, t.date],
          set: {
            commit_count: sql`excluded.commit_count`,
            prs_merged: sql`excluded.prs_merged`,
            synced_at: sql`excluded.synced_at`,
          },
        });
    }

    // Per-user attribution: map → email → unmatched.
    const perUserDay = new Map<string, number>(); // `${userId}\u0000${date}` -> count (NUL escape - cannot occur in a user_id)
    for (const c of commitData) {
      const day = new Date(c.date);
      if (isNaN(day.getTime())) continue;
      const dateKey = day.toISOString().slice(0, 10);
      const userId = resolveAuthor({ email: c.email, login: c.login });
      if (userId) {
        const key = `${userId}\u0000${dateKey}`;
        perUserDay.set(key, (perUserDay.get(key) ?? 0) + 1);
      } else {
        const identity = bestUnmatchedIdentity({ email: c.email, login: c.login });
        // Bots can never be mapped to a person -- never queue them. Also skip
        // anything longer than the identity route's 200-char cap, so the
        // queue can never display an identity the mapping POST would 400 on.
        if (identity && !isBotIdentity(identity) && identity.length <= 200) {
          unmatchedCounts.set(identity, (unmatchedCounts.get(identity) ?? 0) + 1);
        }
      }
    }
    await client.delete(gurs).where(and(eq(gurs.repo, m.repo), gte(gurs.date, sinceDateStr)));
    for (const [key, count] of perUserDay) {
      const [userId, dateKey] = key.split('\u0000');
      await client
        .insert(gurs)
        .values({ user_id: userId, repo: m.repo, date: dateKey, commit_count: count, synced_at: now })
        .onConflictDoUpdate({
          target: [gurs.user_id, gurs.repo, gurs.date],
          set: { commit_count: sql`excluded.commit_count`, synced_at: sql`excluded.synced_at` },
        });
    }

    synced++;
  }

  // Unmatched-author queue: wiped and rewritten every sync (never accumulates),
  // capped — the admin GitHub tab is its only surface. Gated on synced > 0:
  // a total-failure sync (every repo failed, e.g. an expired PAT) must leave
  // the existing queue intact rather than wiping it to empty; a PARTIAL
  // failure (some repos synced) still rewrites, since the queue then
  // reflects what was actually measured this run.
  if (synced > 0) {
    await client.delete(gua);
    const topUnmatched = [...unmatchedCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, UNMATCHED_CAP);
    for (const [identity, count] of topUnmatched) {
      await client.insert(gua).values({ identity, commit_count: count, last_synced: now });
    }
  }

  await setConfigValue('githubSyncLastRun', new Date().toISOString());
  console.log(`[GithubSync] ${synced} repo(s) synced, ${failed} failed`);
  return { synced, failed, errors };
}
