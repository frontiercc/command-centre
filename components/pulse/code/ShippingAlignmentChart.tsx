// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import type { ReactNode } from 'react';
import { smoothPath, type ChartPoint } from '@/lib/charts/smooth-path';
import { PRODUCT_COLOR } from '@/lib/ui/chart-colours';
import { Panel, Muted } from '@/components/precision/ui';

export interface ShippingDay {
  date: string;
  aiCommits: number;
  ghCommits: number;
  ghPrs: number;
  /** GitHub commits split by tool; null on a day synced before the split (total only). */
  ghClaude?: number | null;
  ghCodex?: number | null;
  ghNone?: number | null;
}

const W = 600;
const H = 120;
const PAD = 8;
const NO_TOOL = '#D9D9D9';
const TOTAL_ONLY = '#EDEDED';

const xAt = (i: number, n: number) => PAD + (i * (W - 2 * PAD)) / Math.max(1, n - 1);
const yAt = (v: number, max: number) => H - PAD - (max > 0 ? (v / max) * (H - 2 * PAD) : 0);

function toPoints(values: number[], max: number): ChartPoint[] {
  return values.map((v, i) => ({ x: xAt(i, values.length), y: yAt(v, max) }));
}

/** One smoothed path per unbroken run of non-null values. */
function runPaths(values: Array<number | null>, max: number): string[] {
  const paths: string[] = [];
  let run: ChartPoint[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (run.length) paths.push(smoothPath(run));
      run = [];
      return;
    }
    run.push({ x: xAt(i, values.length), y: yAt(v, max) });
  });
  if (run.length) paths.push(smoothPath(run));
  return paths;
}

const known = (d: ShippingDay) => d.ghClaude != null && d.ghCodex != null && d.ghNone != null;

/**
 * 30-day daily view: commits on the GitHub-tracked repos beside the commits
 * Claude Code and Codex recorded. Once a GitHub sync has matched commits to
 * tools (author email belongs to a person, and that person's Claude Code or
 * Codex recorded a commit at about the same time), the Claude and Codex tabs
 * show the GitHub commits made with that tool, and the All tab stacks the
 * GitHub bars by tool: Claude Code, Codex, no AI tool recorded. Days synced
 * before the split show the GitHub total only.
 *
 * `children` (optional) render at the foot of the same panel; the Overview
 * puts the per-repo cards there.
 */
export default function ShippingAlignmentChart({ series, children, codexPresent = false, openaiOnly = false, view }: {
  series: ShippingDay[];
  children?: ReactNode;
  /** Codex data exists: the AI-assisted commits include Codex's. */
  codexPresent?: boolean;
  /** Only OpenAI is connected: the AI-assisted commits are Codex's alone. */
  openaiOnly?: boolean;
  /** Developer Pulse's All / Claude / Codex switch. Omitted: worked out from the two flags above. */
  view?: 'all' | 'claude' | 'openai';
}) {
  if (series.length === 0) {
    return children ? <Panel title="Shipping alignment" subtitle="30 days" flush>{children}</Panel> : null;
  }

  const tab: 'all' | 'claude' | 'openai' = view ?? (openaiOnly ? 'openai' : codexPresent ? 'all' : 'claude');
  const tool = tab === 'openai' ? 'Codex' : tab === 'claude' ? 'Claude Code' : (codexPresent ? 'Claude Code and Codex' : 'Claude Code');
  const anySplit = series.some(known);
  const anyTotalOnly = series.some(d => !known(d));

  const totalAi = series.reduce((s, d) => s + d.aiCommits, 0);
  const totalGh = series.reduce((s, d) => s + d.ghCommits, 0);
  const totalPrs = series.reduce((s, d) => s + d.ghPrs, 0);
  const grid = [0.25, 0.5, 0.75].map(f => PAD + f * (H - 2 * PAD));
  const n = series.length;

  // Claude and Codex tabs, once matched: the GitHub line is that tool's matched commits.
  const singleTool = anySplit && tab !== 'all';
  const matched = (d: ShippingDay) => (tab === 'openai' ? d.ghCodex : d.ghClaude) ?? null;
  const matchedValues = series.map(d => (known(d) ? matched(d) : null));
  const totalMatched = matchedValues.reduce<number>((s, v) => s + (v ?? 0), 0);
  // Days synced before the split: the total, drawn faint.
  const totalOnlyValues = series.map(d => (known(d) ? null : d.ghCommits));

  const stacked = anySplit && tab === 'all';
  const max = Math.max(
    ...series.map(d => Math.max(singleTool ? (known(d) ? (matched(d) ?? 0) : d.ghCommits) : d.ghCommits, d.aiCommits)),
    1,
  );
  const aiPath = smoothPath(toPoints(series.map(d => d.aiCommits), max));
  const barW = Math.max(2, ((W - 2 * PAD) / n) * 0.6);

  const legendSwatch = (color: string, kind: 'line' | 'bar') => (
    <span className={kind === 'line' ? 'w-3 h-0.5 inline-block' : 'w-2.5 h-2.5 inline-block rounded-[2px]'} style={{ background: color }} />
  );

  return (
    <Panel
      title="Shipping alignment"
      subtitle="30 days"
      right={<span className="text-[13px] text-[#666666] tabular-nums">{totalPrs} merged PR{totalPrs === 1 ? '' : 's'} in window (GitHub)</span>}
      flush
    >
      <div className="p-4 flex flex-col gap-2.5">
        <Muted>
          {singleTool
            ? <>Daily GitHub commits made with {tool} on the tracked repos, beside the commits {tool} recorded itself.</>
            : stacked
              ? <>Daily GitHub commits on the tracked repos by the tool that made them, beside the commits {tool} recorded {codexPresent ? 'themselves' : 'itself'}.</>
              : <>Daily commits on the GitHub-tracked repos beside commits made inside {tool} sessions: same-day volumes, measured on both sides, not attribution.</>}
          {' '}
          {anySplit
            ? <>A GitHub commit counts as made with a tool when its author email belongs to a Command Centre person (commit author mapping covers other addresses) and that person&apos;s Claude Code or Codex activity recorded a commit within 15 minutes of it. Commits made with a tool that is not connected count as no AI tool recorded.{anyTotalOnly ? ' Days synced before this matching show the GitHub total only.' : ''}</>
            : <>Different denominators: AI coding activity is org-wide; GitHub commits cover the tracked repos only. Commits made with each tool appear after the next GitHub sync.</>}
        </Muted>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height={H}
          preserveAspectRatio="none"
          role="img"
          aria-label={singleTool
            ? `Daily GitHub commits made with ${tool} vs ${tool}'s recorded commits, last 30 days`
            : stacked
              ? 'Daily GitHub commits on tracked repos by tool vs AI-assisted commits, last 30 days'
              : 'Daily GitHub commits on tracked repos vs AI-assisted commits, last 30 days'}
        >
          {grid.map(y => (
            <line key={y} x1={0} x2={W} y1={y} y2={y} stroke="#F2F2F2" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          {stacked && series.map((d, i) => {
            const x = xAt(i, n) - barW / 2;
            if (!known(d)) {
              const top = yAt(d.ghCommits, max);
              return <rect key={d.date} x={x} y={top} width={barW} height={H - PAD - top} fill={TOTAL_ONLY} />;
            }
            const parts: Array<[number, string]> = [
              [d.ghClaude ?? 0, PRODUCT_COLOR.claude_code],
              [d.ghCodex ?? 0, PRODUCT_COLOR.codex],
              [d.ghNone ?? 0, NO_TOOL],
            ];
            let base = 0;
            return (
              <g key={d.date}>
                {parts.map(([v, color], k) => {
                  if (v <= 0) return null;
                  const y0 = yAt(base, max);
                  base += v;
                  const y1 = yAt(base, max);
                  return <rect key={k} x={x} y={y1} width={barW} height={y0 - y1} fill={color} />;
                })}
              </g>
            );
          })}
          {!stacked && !singleTool && (
            <path d={smoothPath(toPoints(series.map(d => d.ghCommits), max))} fill="none" stroke="#B3B3B3" strokeWidth={1.5} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          )}
          {singleTool && runPaths(totalOnlyValues, max).map((d, i) => (
            <path key={`t${i}`} d={d} fill="none" stroke="#D9D9D9" strokeWidth={1.5} strokeDasharray="3 3" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          ))}
          {singleTool && runPaths(matchedValues, max).map((d, i) => (
            <path key={`m${i}`} d={d} fill="none" stroke="#B3B3B3" strokeWidth={1.5} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          ))}
          <path d={aiPath} fill="none" stroke="#05073F" strokeWidth={2} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-[#666666] tabular-nums">
          <span className="flex items-center gap-1.5">
            {legendSwatch('#05073F', 'line')} {singleTool ? `Commits ${tool} recorded` : 'AI-assisted commits'} ({totalAi})
          </span>
          {singleTool ? (
            <>
              <span className="flex items-center gap-1.5">
                {legendSwatch('#B3B3B3', 'line')} GitHub commits made with {tool} ({totalMatched})
              </span>
              {anyTotalOnly && (
                <span className="flex items-center gap-1.5">
                  {legendSwatch('#D9D9D9', 'line')} GitHub total, before matching
                </span>
              )}
            </>
          ) : stacked ? (
            <>
              <span className="flex items-center gap-1.5">
                {legendSwatch(PRODUCT_COLOR.claude_code, 'bar')} GitHub, made with Claude Code ({series.reduce((s, d) => s + (d.ghClaude ?? 0), 0)})
              </span>
              {codexPresent && (
                <span className="flex items-center gap-1.5">
                  {legendSwatch(PRODUCT_COLOR.codex, 'bar')} GitHub, made with Codex ({series.reduce((s, d) => s + (d.ghCodex ?? 0), 0)})
                </span>
              )}
              <span className="flex items-center gap-1.5">
                {legendSwatch(NO_TOOL, 'bar')} GitHub, no AI tool recorded ({series.reduce((s, d) => s + (d.ghNone ?? 0), 0)})
              </span>
              {anyTotalOnly && (
                <span className="flex items-center gap-1.5">
                  {legendSwatch(TOTAL_ONLY, 'bar')} GitHub total, before matching
                </span>
              )}
            </>
          ) : (
            <span className="flex items-center gap-1.5">
              {legendSwatch('#B3B3B3', 'line')} GitHub commits, tracked repos ({totalGh})
            </span>
          )}
        </div>
      </div>
      {children}
    </Panel>
  );
}
