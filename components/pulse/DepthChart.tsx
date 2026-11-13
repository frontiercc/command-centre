// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * "Is the work getting deeper?" at two zoom levels, one colour (petrol).
 *
 *  - Last 6 weeks: the delegation journey grid, a count per tier per week, counting back from
 *    today so the week in progress is always there. This is what a new starter sees.
 *  - Last quarter / 2 quarters / year: the share of tasks at each depth over completed weeks,
 *    or completed months for the year.
 *
 * Every week in a window gets a column, empty or not, and text is real HTML at a fixed size so
 * it never grows with the page width.
 */
import type { ReactNode } from 'react';
import { DASH_SHADES, shareWords } from '@/components/dashboard/QuestionCard';
import { deepWords, tierList, type TierNames } from '@/lib/pulse/tier-names';

export interface TierWeek { weekStart: number; t1: number; t2: number; t3: number }
export type DepthWindow = 6 | 13 | 26 | 52;

const WEEK = 7 * 86400;
export const DEPTH_WINDOWS: DepthWindow[] = [6, 13, 26, 52];
export const WINDOW_LABEL: Record<DepthWindow, string> = {
  6: 'Last 6 weeks', 13: 'Last quarter', 26: 'Last 2 quarters', 52: 'Last year',
};
const SPAN_WORDS: Record<DepthWindow, string> = {
  6: 'the last six weeks', 13: 'the last quarter', 26: 'the last two quarters', 52: 'the last year',
};

/** Monday 00:00 UTC of the week containing ts. */
function mondayOf(ts: number): number {
  const d = new Date(ts * 1000);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  return midnight - ((d.getUTCDay() + 6) % 7) * 86400;
}

const fmtDay = (s: number) => new Date(s * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export interface DepthColumn { start: number; label: string; t1: number; t2: number; t3: number }

/** The completed weeks (or, for the year, the last 12 calendar months) of the window, every one present. */
export function depthColumns(weeks: TierWeek[], window: DepthWindow, nowS: number): DepthColumn[] {
  const byWeek = new Map(weeks.map(w => [w.weekStart, w]));
  const current = mondayOf(nowS);
  if (window !== 52) {
    return Array.from({ length: window }, (_, i) => {
      const start = current - (window - i) * WEEK;
      const w = byWeek.get(start);
      return { start, label: fmtDay(start), t1: w?.t1 ?? 0, t2: w?.t2 ?? 0, t3: w?.t3 ?? 0 };
    });
  }
  // Last year: the 12 calendar months ending with the month of the last completed week.
  const last = new Date((current - WEEK) * 1000);
  const months = Array.from({ length: 12 }, (_, i) => {
    const m = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() - 11 + i, 1));
    return { y: m.getUTCFullYear(), m: m.getUTCMonth(), start: m.getTime() / 1000 };
  });
  return months.map(({ y, m, start }) => {
    const col = { start, label: '', t1: 0, t2: 0, t3: 0 };
    for (const w of weeks) {
      const d = new Date(w.weekStart * 1000);
      if (d.getUTCFullYear() === y && d.getUTCMonth() === m && w.weekStart < current) { col.t1 += w.t1; col.t2 += w.t2; col.t3 += w.t3; }
    }
    col.label = new Date(start * 1000).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC', ...(m === 0 ? { year: 'numeric' } : {}) });
    return col;
  });
}

const total = (c: { t1: number; t2: number; t3: number }) => c.t1 + c.t2 + c.t3;
const realShare = (cs: DepthColumn[]) => { const a = cs.reduce((s, c) => s + total(c), 0); return a > 0 ? cs.reduce((s, c) => s + c.t2 + c.t3, 0) / a : null; };
const words = (v: number) => (v < 0.15 ? `${Math.round(v * 100)}%` : shareWords(v));
const plural = (c: number, one: string, many: string) => `${c} ${c === 1 ? one : many}`;

/**
 * One sentence on the whole span shown: the top two tiers' share in its first month against its last.
 * A first month with no work is skipped and the sentence says where the work starts.
 */
export function depthSentence(cols: DepthColumn[], window: DepthWindow, whose: string, names?: TierNames, unit: 'task' | 'session' = 'task'): ReactNode {
  const per = window === 52 ? 1 : 4; // columns in a month
  const withData = cols.map((c, i) => (total(c) > 0 ? i : -1)).filter(i => i >= 0);
  if (withData.length < per * 2) return <>Not enough weeks of work yet to compare over {SPAN_WORDS[window]}.</>;
  const firstIdx = withData.slice(0, per), lastIdx = withData.slice(-per);
  const first = realShare(firstIdx.map(i => cols[i]))!;
  const last = realShare(lastIdx.map(i => cols[i]))!;
  const up = Math.round(last * 100) - Math.round(first * 100);
  const verdict = up > 2 ? 'Yes. ' : up < -2 ? 'No. ' : 'About the same. ';
  const startsLate = firstIdx[0] > 0;
  const monthName = new Date(cols[firstIdx[0]].start * 1000).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
  const firstWhen = !startsLate ? 'in its first month'
    : window === 52 ? `in ${monthName}, the first month with work` : `in the first month with work, from ${cols[firstIdx[0]].label}`;
  return <>{verdict}Over {SPAN_WORDS[window]}, {deepWords(names)} work went from <b>{words(first)}</b> of {whose ? `${whose} ` : ''}{unit}s {firstWhen} to <b>{words(last)}</b> in its last month.</>;
}

/** The grid's sentence: this week first, because that is what a new starter needs to see. */
export function gridSentence(grid: TierWeek[], whose: string, names?: TierNames, unit: 'task' | 'session' = 'task'): ReactNode {
  const now = grid[grid.length - 1], prev = grid[grid.length - 2];
  const real = (w?: TierWeek) => (w ? w.t2 + w.t3 : 0);
  const six = grid.reduce((s, w) => s + total(w), 0);
  const who = whose ? `${whose} ` : '';
  if (six === 0) return <>No classified {unit}s in the last six weeks.</>;
  const deep = deepWords(names);
  if (total(now) > 0) {
    return <>This week so far, {who}<b>{plural(total(now), unit, `${unit}s`)}</b>, {real(now) === 0 ? <>none of them {deep} yet</> : <><b>{real(now)} of them</b> {deep}</>}. Six weeks: {plural(six, unit, `${unit}s`)}.</>;
  }
  if (prev && total(prev) > 0) {
    return <>Nothing yet this week. Last week {who}<b>{plural(total(prev), unit, `${unit}s`)}</b>, {real(prev)} of them {deep}.</>;
  }
  return <>Nothing in the last two weeks. Six weeks: {plural(six, unit, `${unit}s`)}.</>;
}

export function DepthSwitch({ window, onWindow, windows = DEPTH_WINDOWS }: {
  window: DepthWindow; onWindow: (w: DepthWindow) => void; windows?: DepthWindow[];
}) {
  return (
    <span className="inline-flex border border-[#EAEAEA] rounded-[8px] overflow-hidden bg-white">
      {windows.map(w => (
        <button key={w} type="button" onClick={() => onWindow(w)} className={`text-[12px] px-2 py-0.5 ${w === window ? 'bg-[#F2F2F2] text-[#0A0A0A] font-medium' : 'bg-white text-[#666666]'}`}>{WINDOW_LABEL[w]}</button>
      ))}
    </span>
  );
}

/** The delegation journey: a count per tier per week, oldest week on the left, this week last. */
export function TierGrid({ grid, names }: { grid: TierWeek[]; names?: TierNames }) {
  const [t1, t2, t3] = tierList(names);
  const tiers: Array<[3 | 2 | 1, string, string]> = [
    [3, t3, DASH_SHADES[2]],
    [2, t2, DASH_SHADES[1]],
    [1, t1, DASH_SHADES[0]],
  ];
  const count = (w: TierWeek, t: 3 | 2 | 1) => (t === 3 ? w.t3 : t === 2 ? w.t2 : w.t1);
  // The row label is as wide as the longest tier name needs, since a customer can rename them.
  const labelW = Math.min(190, Math.max(104, Math.max(...tiers.map(t => t[1].length)) * 7));
  const cols = `${labelW}px repeat(${grid.length}, minmax(0,1fr))`;
  return (
    <div>
      <div className="grid gap-1 text-[11px] text-[#8F8F8F] pb-1" style={{ gridTemplateColumns: cols }}>
        <span />
        {grid.map((w, i) => (
          <span key={w.weekStart} className="text-center">{i === grid.length - 1 ? 'This week' : fmtDay(w.weekStart)}</span>
        ))}
      </div>
      {tiers.map(([t, label, colour]) => (
        <div key={t} className="grid gap-1 items-center py-[2px]" style={{ gridTemplateColumns: cols }}>
          <span className="text-[12px] text-[#333333] leading-4">{label}</span>
          {grid.map(w => {
            const c = count(w, t);
            return (
              <span
                key={w.weekStart}
                title={`${fmtDay(w.weekStart)}: ${c}`}
                className="h-6 rounded-[6px] flex items-center justify-center text-[12px] font-semibold tabular-nums"
                style={c > 0
                  ? { background: colour, color: t === 3 ? '#FFFFFF' : '#134A5E' }
                  : { background: '#FAFAFA', color: '#C9C9C9' }}
              >
                {c > 0 ? c : ''}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function DepthChart({ cols, height = 80, names }: { cols: DepthColumn[]; height?: number; names?: TierNames }) {
  const n = cols.length;
  const gap = n > 13 ? 2 : 4;
  const every = n > 13 ? 2 : 1;
  return (
    <div>
      <div className="flex">
        <div className="w-8 shrink-0 flex flex-col justify-between text-[11px] leading-none text-[#8F8F8F] pr-1.5 text-right" style={{ height }}>
          <span>100%</span><span>50%</span><span>0%</span>
        </div>
        <div className="relative flex-1 flex items-end border-b border-[#EAEAEA]" style={{ height, gap }} role="img" aria-label="Tasks by depth">
          <span className="absolute left-0 right-0 top-0 border-t border-[#F2F2F2]" />
          <span className="absolute left-0 right-0 top-1/2 border-t border-[#F2F2F2]" />
          {cols.map(c => {
            const t = total(c);
            return (
              <div key={c.start} className="relative flex-1 h-full flex flex-col-reverse" title={t ? `${c.label}: ${t} tasks` : `${c.label}: no work`}>
                {t > 0 && [c.t1, c.t2, c.t3].map((v, j) => <span key={j} style={{ height: `${(v / t) * 100}%`, background: DASH_SHADES[j] }} />)}
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex pl-8 mt-1" style={{ gap }}>
        {cols.map((c, i) => (
          <span key={c.start} className="flex-1 min-w-0 text-center text-[11px] text-[#8F8F8F] whitespace-nowrap overflow-visible">{i % every === 0 || i === n - 1 ? c.label : ''}</span>
        ))}
      </div>
      <TierLegend names={names} />
    </div>
  );
}

export function TierLegend({ names }: { names?: TierNames }) {
  return (
    <div className="flex flex-wrap gap-x-3.5 mt-1.5 text-[12px] text-[#777777]">
      {tierList(names).map((l, i) => (
        <span key={l} className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[2px]" style={{ background: DASH_SHADES[i] }} />{l}</span>
      ))}
    </div>
  );
}
