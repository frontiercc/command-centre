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
  /** Tool split of commit_count (migration 0047); null/absent = synced before the split. */
  claude?: number | null;
  codex?: number | null;
  none?: number | null;
}

export interface ShippingDay {
  date: string;
  aiCommits: number;   // org-wide commits made inside Claude Code sessions
  ghCommits: number;   // total commits across tracked repos (GitHub)
  ghPrs: number;       // merged PRs across tracked repos (GitHub)
  /**
   * ghCommits split by the tool that made each commit (matched by person and
   * time). All three null when any tracked repo's row for the day was synced
   * before the split existed: that day shows the total only.
   */
  ghClaude: number | null;
  ghCodex: number | null;
  ghNone: number | null;
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
  const split = new Map<string, { claude: number; codex: number; none: number } | null>();
  for (const r of ghRows) {
    ghCommits.set(r.date, (ghCommits.get(r.date) ?? 0) + r.commit_count);
    ghPrs.set(r.date, (ghPrs.get(r.date) ?? 0) + r.prs_merged);
    const known = r.claude != null && r.codex != null && r.none != null;
    const cur = split.has(r.date) ? split.get(r.date)! : { claude: 0, codex: 0, none: 0 };
    split.set(r.date, cur === null || !known ? null : {
      claude: cur.claude + r.claude!, codex: cur.codex + r.codex!, none: cur.none + r.none!,
    });
  }
  return days.map(date => {
    // A day with no rows is a genuine zero (the sync rewrites the window), split included.
    const s = split.has(date) ? split.get(date)! : { claude: 0, codex: 0, none: 0 };
    return {
      date,
      aiCommits: aiByDay[date] ?? 0,
      ghCommits: ghCommits.get(date) ?? 0,
      ghPrs: ghPrs.get(date) ?? 0,
      ghClaude: s ? s.claude : null,
      ghCodex: s ? s.codex : null,
      ghNone: s ? s.none : null,
    };
  });
}

/** True when any row carries the tool split, i.e. a sync has run since migration 0047. */
export function hasToolSplit(ghRows: GhDailyRow[]): boolean {
  return ghRows.some(r => r.claude != null && r.codex != null && r.none != null);
}

export interface CodexRepoReach {
  /** Tracked repos with at least one commit matched to Codex in the window's last 7 days. */
  activeRepos7d: number;
  /** Tracked repos with no commit matched to Codex in the whole 30-day window. */
  quietRepos30d: number;
  trackedRepos: number;
}

/**
 * Codex reports no repository, so its reach is worked out from GitHub
 * commits matched to Codex, on the tracked repos only. Null until a sync has
 * written the tool split.
 */
export function buildCodexRepoReach(days: string[], ghRows: GhDailyRow[], trackedRepos: string[]): CodexRepoReach | null {
  if (!hasToolSplit(ghRows)) return null;
  const last7 = new Set(days.slice(-7));
  const window = new Set(days);
  const active7 = new Set<string>();
  const active30 = new Set<string>();
  for (const r of ghRows) {
    if (!window.has(r.date) || !(r.codex != null && r.codex > 0)) continue;
    active30.add(r.repo);
    if (last7.has(r.date)) active7.add(r.repo);
  }
  return {
    activeRepos7d: active7.size,
    quietRepos30d: trackedRepos.filter(repo => !active30.has(repo)).length,
    trackedRepos: trackedRepos.length,
  };
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
