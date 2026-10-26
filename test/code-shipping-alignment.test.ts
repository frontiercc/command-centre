// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import {
  buildDailyWindow,
  buildShippingSeries,
  buildRepoCards,
  countReposActive7d,
  type GhDailyRow,
} from '@/lib/pulse/code/shipping-alignment';

const gh = (repo: string, date: string, commits: number, prs = 0): GhDailyRow =>
  ({ repo, date, commit_count: commits, prs_merged: prs });

describe('buildDailyWindow', () => {
  it('returns N consecutive UTC dates ending at todayUtc inclusive, oldest first', () => {
    const days = buildDailyWindow('2026-08-03', 5);
    expect(days).toEqual(['2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02', '2026-08-03']);
  });

  it('crosses month boundaries correctly', () => {
    expect(buildDailyWindow('2026-08-01', 2)).toEqual(['2026-07-31', '2026-08-01']);
  });

  it('returns 30 entries for a 30-day window', () => {
    expect(buildDailyWindow('2026-08-03', 30)).toHaveLength(30);
  });
});

describe('buildShippingSeries', () => {
  const days = buildDailyWindow('2026-08-03', 3); // 08-01, 08-02, 08-03

  it('zero-fills days with no data on either side', () => {
    const series = buildShippingSeries(days, {}, []);
    expect(series).toEqual([
      { date: '2026-08-01', aiCommits: 0, ghCommits: 0, ghPrs: 0 },
      { date: '2026-08-02', aiCommits: 0, ghCommits: 0, ghPrs: 0 },
      { date: '2026-08-03', aiCommits: 0, ghCommits: 0, ghPrs: 0 },
    ]);
  });

  it('sums GitHub rows across repos per day and maps AI commits by day', () => {
    const series = buildShippingSeries(
      days,
      { '2026-08-02': 4 },
      [gh('a/x', '2026-08-02', 3, 1), gh('a/y', '2026-08-02', 2), gh('a/x', '2026-08-03', 5, 2)],
    );
    expect(series[1]).toEqual({ date: '2026-08-02', aiCommits: 4, ghCommits: 5, ghPrs: 1 });
    expect(series[2]).toEqual({ date: '2026-08-03', aiCommits: 0, ghCommits: 5, ghPrs: 2 });
  });

  it('ignores GitHub rows outside the window', () => {
    const series = buildShippingSeries(days, {}, [gh('a/x', '2026-07-01', 99)]);
    expect(series.every(d => d.ghCommits === 0)).toBe(true);
  });
});

describe('buildRepoCards', () => {
  const days = buildDailyWindow('2026-08-03', 30);

  it('computes 7d, prev-7d, 30d totals and a 30-slot daily array per repo, sorted by 30d commits desc', () => {
    const rows: GhDailyRow[] = [
      gh('a/busy', '2026-08-03', 5, 1),   // in last-7
      gh('a/busy', '2026-07-25', 2),      // in prev-7 (days -14..-8)
      gh('a/busy', '2026-07-10', 1),      // in 30d only
      gh('a/quiet', '2026-08-01', 1),
    ];
    const cards = buildRepoCards(days, rows);
    expect(cards.map(c => c.repo)).toEqual(['a/busy', 'a/quiet']);
    const busy = cards[0];
    expect(busy.commits7d).toBe(5);
    expect(busy.commitsPrev7d).toBe(2);
    expect(busy.commits30d).toBe(8);
    expect(busy.prs30d).toBe(1);
    expect(busy.daily).toHaveLength(30);
    expect(busy.daily[29]).toBe(5); // last slot = todayUtc
  });

  it('returns [] when there are no rows', () => {
    expect(buildRepoCards(days, [])).toEqual([]);
  });
});

describe('countReposActive7d', () => {
  const days = buildDailyWindow('2026-08-03', 30);

  it('counts distinct repos with >=1 commit in the last 7 days only', () => {
    const rows: GhDailyRow[] = [
      gh('a/x', '2026-08-02', 3),   // active
      gh('a/y', '2026-07-30', 1),   // active (within last 7: 07-28..08-03)
      gh('a/z', '2026-07-10', 9),   // outside last 7
      gh('a/w', '2026-08-01', 0),   // zero-commit row is NOT active
    ];
    expect(countReposActive7d(days, rows)).toBe(2);
  });
});
