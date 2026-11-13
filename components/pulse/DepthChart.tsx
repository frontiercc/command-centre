// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * "Is the work getting deeper?": routine, meaningful and frontier tasks over a quarter, two
 * quarters or a year. Weekly columns for the quarter and two quarters, monthly for the year.
 * Every week in the window gets a column, empty or not. Text is real HTML at a fixed size,
 * so it never grows with the page width.
 */
import type { ReactNode } from 'react';
import { DASH_SHADES, shareWords } from '@/components/dashboard/QuestionCard';

export interface TierWeek { weekStart: number; t1: number; t2: number; t3: number }
export type DepthWindow = 13 | 26 | 52;

const WEEK = 7 * 86400;
export const WINDOW_LABEL: Record<DepthWindow, string> = { 13: 'Last quarter', 26: 'Last 2 quarters', 52: 'Last year' };
const SPAN_WORDS: Record<DepthWindow, string> = { 13: 'the last quarter', 26: 'the last two quarters', 52: 'the last year' };

/** Monday 00:00 UTC of the week containing ts. */
function mondayOf(ts: number): number {
  const d = new Date(ts * 1000);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  return midnight - ((d.getUTCDay() + 6) % 7) * 86400;
}

export interface DepthColumn { start: number; label: string; t1: number; t2: number; t3: number }

/** The completed weeks (or, for the year, the last 12 calendar months) of the window, every one present. */
export function depthColumns(weeks: TierWeek[], window: DepthWindow, nowS: number): DepthColumn[] {
  const byWeek = new Map(weeks.map(w => [w.weekStart, w]));
  const current = mondayOf(nowS);
  const fmtDay = (s: number) => new Date(s * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
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

const total = (c: DepthColumn) => c.t1 + c.t2 + c.t3;
const realShare = (cs: DepthColumn[]) => { const a = cs.reduce((s, c) => s + total(c), 0); return a > 0 ? cs.reduce((s, c) => s + c.t2 + c.t3, 0) / a : null; };
const words = (v: number) => (v < 0.15 ? `${Math.round(v * 100)}%` : shareWords(v));

/**
 * One sentence on the whole span shown: real work in its first month against its last month.
 * A first month with no work is skipped and the sentence says where the work starts.
 */
export function depthSentence(cols: DepthColumn[], window: DepthWindow, whose: string): ReactNode {
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
  return <>{verdict}Over {SPAN_WORDS[window]}, real work went from <b>{words(first)}</b> of {whose ? `${whose} ` : ''}tasks {firstWhen} to <b>{words(last)}</b> in its last month.</>;
}

export function DepthSwitch({ window, onWindow }: { window: DepthWindow; onWindow: (w: DepthWindow) => void }) {
  return (
    <span className="inline-flex border border-[#EAEAEA] rounded-[8px] overflow-hidden bg-white">
      {([13, 26, 52] as const).map(w => (
        <button key={w} type="button" onClick={() => onWindow(w)} className={`text-[12px] px-2 py-0.5 ${w === window ? 'bg-[#F2F2F2] text-[#0A0A0A] font-medium' : 'bg-white text-[#666666]'}`}>{WINDOW_LABEL[w]}</button>
      ))}
    </span>
  );
}

export function DepthChart({ cols, height = 80 }: { cols: DepthColumn[]; height?: number }) {
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
      <div className="flex flex-wrap gap-x-3.5 mt-1.5 text-[12px] text-[#777777]">
        {['Routine', 'Meaningful', 'Frontier'].map((l, i) => <span key={l} className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[2px]" style={{ background: DASH_SHADES[i] }} />{l}</span>)}
      </div>
    </div>
  );
}
