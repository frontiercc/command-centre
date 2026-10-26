// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Pure builders for the GitHub Shipping Alignment view.
// No DB, no config, no IO — the org-summary route does the two queries and
// hands rows in; everything here is fixtures-testable.
//
// Zero semantics: a day inside the synced window with no row is a genuine
// "0 commits" (the GitHub sync rewrites the whole 35-day window every run),
// so the series zero-fills — this is NOT the null-vs-zero case Sparkline
// guards for on weekly metric series.

const DAY_MS = 24 * 3600 * 1000;

export interface GhDailyRow {
  repo: string;
  date: string;        // YYYY-MM-DD (UTC), as stored in github_repo_stats
  commit_count: number;
  prs_merged: number;
}

export interface ShippingDay {
  date: string;
  aiCommits: number;   // org-wide commits made inside Claude Code sessions
  ghCommits: number;   // total commits across tracked repos (GitHub)
  ghPrs: number;       // merged PRs across tracked repos (GitHub)
}

export interface RepoShippingCard {
  repo: string;
  commits7d: number;
  commitsPrev7d: number;
  prs30d: number;
  commits30d: number;
  daily: number[];     // one commit count per window day, oldest first
}

/** N consecutive UTC dates ending at todayUtc inclusive, oldest first. */
export function buildDailyWindow(todayUtc: string, days: number): string[] {
  const end = new Date(`${todayUtc}T00:00:00Z`).getTime();
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(new Date(end - i * DAY_MS).toISOString().slice(0, 10));
  }
  return out;
}

export function buildShippingSeries(
  days: string[],
  aiByDay: Record<string, number>,
  ghRows: GhDailyRow[],
): ShippingDay[] {
  const ghCommits = new Map<string, number>();
  const ghPrs = new Map<string, number>();
  for (const r of ghRows) {
    ghCommits.set(r.date, (ghCommits.get(r.date) ?? 0) + r.commit_count);
    ghPrs.set(r.date, (ghPrs.get(r.date) ?? 0) + r.prs_merged);
  }
  return days.map(date => ({
    date,
    aiCommits: aiByDay[date] ?? 0,
    ghCommits: ghCommits.get(date) ?? 0,
    ghPrs: ghPrs.get(date) ?? 0,
  }));
}

export function buildRepoCards(days: string[], ghRows: GhDailyRow[]): RepoShippingCard[] {
  const last7 = new Set(days.slice(-7));
  const prev7 = new Set(days.slice(-14, -7));
  const byRepo = new Map<string, Map<string, GhDailyRow>>();
  for (const r of ghRows) {
    if (!byRepo.has(r.repo)) byRepo.set(r.repo, new Map());
    byRepo.get(r.repo)!.set(r.date, r);
  }
  const cards: RepoShippingCard[] = [];
  for (const [repo, rows] of byRepo) {
    let commits7d = 0, commitsPrev7d = 0, prs30d = 0, commits30d = 0;
    const daily = days.map(date => {
      const row = rows.get(date);
      const c = row?.commit_count ?? 0;
      commits30d += c;
      prs30d += row?.prs_merged ?? 0;
      if (last7.has(date)) commits7d += c;
      if (prev7.has(date)) commitsPrev7d += c;
      return c;
    });
    cards.push({ repo, commits7d, commitsPrev7d, prs30d, commits30d, daily });
  }
  return cards.sort((a, b) => b.commits30d - a.commits30d);
}

/** Distinct tracked repos with >=1 commit in the window's last 7 days. */
export function countReposActive7d(days: string[], ghRows: GhDailyRow[]): number {
  const last7 = new Set(days.slice(-7));
  const active = new Set<string>();
  for (const r of ghRows) {
    if (last7.has(r.date) && r.commit_count > 0) active.add(r.repo);
  }
  return active.size;
}
