// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Spark, cx } from '@/components/precision/ui';

export interface RepoShippingCard {
  repo: string;
  commits7d: number;
  commitsPrev7d: number;
  prs30d: number;
  commits30d: number;
  daily: number[];
}

function wowDelta(current: number, previous: number): number | null {
  if (previous === 0) return null; // no prior-week base — never invent a percentage
  return Math.round(((current - previous) / previous) * 100);
}

/**
 * Per-tracked-repo GitHub shipping volume. Repo-level daily aggregates only — no authors, ever.
 * Renders a row of repos divided by hairlines, meant to sit at the foot of the Shipping
 * alignment panel (it carries a top hairline, no outer border).
 */
export default function GithubRepoCards({ cards }: { cards: RepoShippingCard[] }) {
  if (cards.length === 0) return null;
  return (
    // Every cell carries a top and left hairline; the wrapper clips the left one on
    // the first column, so dividers sit only between cells at any column count.
    <div className="overflow-hidden rounded-b-[8px]">
    <div className="grid grid-cols-1 md:grid-cols-3 -ml-px w-[calc(100%+1px)]">
      {cards.map(c => {
        const delta = wowDelta(c.commits7d, c.commitsPrev7d);
        return (
          <div key={c.repo} className="px-4 py-3.5 flex flex-col gap-1.5 min-w-0 border-t border-l border-[#EAEAEA]">
            <span className="font-mono text-[13px] text-[#0A0A0A] truncate" title={c.repo}>{c.repo}</span>
            <div className="flex items-baseline gap-2">
              <span className="text-[20px] leading-6 font-semibold tabular-nums text-[#0A0A0A]">{c.commits7d}</span>
              <span className="text-[13px] text-[#8F8F8F]">commits, 7 days</span>
              {delta !== null && (
                <span className={cx('ml-auto text-[13px] tabular-nums', delta > 0 ? 'text-[#1A7F37]' : delta < 0 ? 'text-[#B42318]' : 'text-[#8F8F8F]')}>
                  {delta >= 0 ? '+' : ''}{delta}% on last week
                </span>
              )}
            </div>
            <div role="img" aria-label={`${c.repo} daily commits, 30 days`}>
              <Spark data={c.daily} width={160} height={22} tone="measured" />
            </div>
            <span className="text-[13px] text-[#8F8F8F] tabular-nums">
              {c.commits30d} commit{c.commits30d === 1 ? '' : 's'} · {c.prs30d} merged PR{c.prs30d === 1 ? '' : 's'}, 30 days (GitHub)
            </span>
          </div>
        );
      })}
    </div>
    </div>
  );
}
