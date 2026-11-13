// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * A small dashboard card: a plain question, its figure, the change on the period before and an
 * 8-week trend. Used by the Work Pulse and Developer Pulse panels so the two read alike.
 * A figure that isn't captured says "Not measured"; it is never shown as 0.
 */
import type { ReactNode } from 'react';

/** The Dashboard's one chart colour (petrol), used for measured and AI-judged alike. */
export const DASH = '#1F6F8B';
/** Three shades of it, lightest first, for the depth of work. */
export const DASH_SHADES = ['#C9DEE6', '#6BA3B8', '#1F6F8B'] as const;

export function QuestionCard({ question, value, unit, change, sub, trend, trendKind = 'line', trendColour, notMeasured }: {
  question: string;
  value?: ReactNode;
  unit?: ReactNode;
  /** Kept for callers; AI-judged is shown by the panel tag, not a colour. */
  judged?: boolean;
  change?: ReactNode;
  sub?: ReactNode;
  trend?: Array<number | null>;
  trendKind?: 'line' | 'bars';
  trendColour?: string;
  /** Shown in place of the figure when it isn't captured. */
  notMeasured?: ReactNode;
}) {
  const colour = trendColour ?? DASH;
  return (
    <div className="border border-[#EFEFEF] rounded-[10px] px-3 py-3 flex flex-col min-w-0">
      <span className="text-[12px] text-[#777777] leading-4 min-h-[32px]">{question}</span>
      {notMeasured ? (
        <>
          <span className="mt-1 text-[14px] font-medium text-[#8F8F8F]">Not measured</span>
          <span className="text-[12px] text-[#666666] mt-0.5">{notMeasured}</span>
        </>
      ) : (
        <>
          <span className="mt-1 text-[20px] leading-6 font-semibold tracking-[-0.01em] tabular-nums text-[#0A0A0A]">
            {value}{unit && <span className="text-[13px] font-normal tracking-normal text-[#8F8F8F]"> {unit}</span>}
          </span>
          {change && <span className="text-[12px] text-[#777777] mt-0.5">{change}</span>}
          {sub && <span className="text-[12px] text-[#777777] mt-0.5">{sub}</span>}
          {trend && trend.filter(v => v !== null).length >= 2 && <Trend data={trend} kind={trendKind} colour={colour} />}
        </>
      )}
    </div>
  );
}

function Trend({ data, kind, colour }: { data: Array<number | null>; kind: 'line' | 'bars'; colour: string }) {
  const W = 200, H = 24;
  const vals = data.filter((v): v is number => v !== null);
  if (kind === 'bars') {
    const max = Math.max(1, ...vals);
    const w = W / data.length;
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[24px] mt-2 block" aria-hidden="true">
        {data.map((v, i) => v === null ? null : (
          <rect key={i} x={i * w + 2} y={H - (v / max) * (H - 2)} width={w - 4} height={Math.max((v / max) * (H - 2), v > 0 ? 1 : 0)} fill={colour} opacity={i === data.length - 1 ? 1 : 0.45} />
        ))}
      </svg>
    );
  }
  const max = Math.max(...vals), min = Math.min(...vals);
  const span = max - min || Math.abs(max) || 1;
  const lo = min - span * 0.15, hi = max + span * 0.15;
  const x = (i: number) => (i * (W - 8)) / Math.max(1, data.length - 1) + 4;
  const y = (v: number) => H - 3 - ((v - lo) / (hi - lo)) * (H - 6);
  const pts = data.map((v, i) => (v === null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(' ');
  const lastIdx = data.map(v => v !== null).lastIndexOf(true);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[24px] mt-2 block" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={colour} strokeWidth={2.5} strokeLinejoin="round" />
      {lastIdx >= 0 && <circle cx={x(lastIdx)} cy={y(data[lastIdx]!)} r={3.5} fill={colour} />}
    </svg>
  );
}


/** "up from 1.18×", "down from 0.56", "the same as before"; null when there is nothing to compare. */
export function changeFrom(now: number | null, before: number | null, fmt: (v: number) => string, period: string): string | null {
  if (now === null || before === null) return null;
  if (fmt(now) === fmt(before)) return `the same as ${period}`;
  return `${now > before ? 'up' : 'down'} from ${fmt(before)} ${period}`;
}
