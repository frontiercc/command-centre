// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import type { ReactNode } from 'react';
import { smoothPath, type ChartPoint } from '@/lib/charts/smooth-path';
import { Panel, Muted } from '@/components/precision/ui';

export interface ShippingDay {
  date: string;
  aiCommits: number;
  ghCommits: number;
  ghPrs: number;
}

const W = 600;
const H = 120;
const PAD = 8;

function toPoints(values: number[], max: number): ChartPoint[] {
  const n = values.length;
  return values.map((v, i) => ({
    x: PAD + (i * (W - 2 * PAD)) / Math.max(1, n - 1),
    y: H - PAD - (max > 0 ? (v / max) * (H - 2 * PAD) : 0),
  }));
}

/**
 * 30-day dual daily line: commits on the GitHub-tracked repos vs commits made
 * inside Claude Code sessions. Same-day volumes, measured on both sides —
 * deliberately NOT an attribution claim (the two sides have different
 * denominators: org-wide Claude activity vs the tracked-repo set).
 *
 * `children` (optional) render at the foot of the same panel — the Overview
 * puts the per-repo cards there.
 */
export default function ShippingAlignmentChart({ series, children }: { series: ShippingDay[]; children?: ReactNode }) {
  if (series.length === 0) {
    return children ? <Panel title="Shipping alignment" subtitle="30 days" flush>{children}</Panel> : null;
  }

  const totalAi = series.reduce((s, d) => s + d.aiCommits, 0);
  const totalGh = series.reduce((s, d) => s + d.ghCommits, 0);
  const totalPrs = series.reduce((s, d) => s + d.ghPrs, 0);
  const max = Math.max(...series.map(d => Math.max(d.ghCommits, d.aiCommits)), 1);
  const ghPath = smoothPath(toPoints(series.map(d => d.ghCommits), max));
  const aiPath = smoothPath(toPoints(series.map(d => d.aiCommits), max));
  const grid = [0.25, 0.5, 0.75].map(f => PAD + f * (H - 2 * PAD));

  return (
    <Panel
      title="Shipping alignment"
      subtitle="30 days"
      right={<span className="text-[13px] text-[#666666] tabular-nums">{totalPrs} merged PR{totalPrs === 1 ? '' : 's'} in window (GitHub)</span>}
      flush
    >
      <div className="p-4 flex flex-col gap-2.5">
        <Muted>
          Daily commits on the GitHub-tracked repos beside commits made inside Claude Code sessions:
          same-day volumes, measured on both sides, not attribution. Different denominators: Claude
          activity is org-wide; GitHub commits cover the tracked repos only.
        </Muted>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height={H}
          preserveAspectRatio="none"
          role="img"
          aria-label="Daily GitHub commits on tracked repos vs AI-assisted commits, last 30 days"
        >
          {grid.map(y => (
            <line key={y} x1={0} x2={W} y1={y} y2={y} stroke="#F2F2F2" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          <path d={ghPath} fill="none" stroke="#B3B3B3" strokeWidth={1.5} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          <path d={aiPath} fill="none" stroke="#05073F" strokeWidth={2} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-[#666666] tabular-nums">
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 bg-[#05073F] inline-block" /> AI-assisted commits ({totalAi})
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 bg-[#B3B3B3] inline-block" /> GitHub commits, tracked repos ({totalGh})
          </span>
        </div>
      </div>
      {children}
    </Panel>
  );
}
