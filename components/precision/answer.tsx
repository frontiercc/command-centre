// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * Answer panels: every panel answers one question in this order.
 *   heading (the question) · answer (one sentence with the key figure, written in code from the
 *   figures, never by the AI) · one chart chosen for the point · what needs attention ·
 *   a link to the detail · a short note on how it's worked out.
 * When there is nothing to say the panel is quiet: heading, one sentence, and at most a thin strip.
 *
 * Colour rules the charts keep:
 *  - measured is charcoal, AI-judged is sky blue, an estimate or projection is striped sky blue;
 *  - amber and red only for worse than a target, so a bar turns amber only on the wrong side of a target line;
 *  - change on its own is grey: more is not good or bad until a target says so;
 *  - every colour has a label beside it (a legend or a label on the mark).
 * Client-safe, no data fetching.
 */
import Link from 'next/link';
import { useId, type ReactNode } from 'react';
import { cx, Spark } from './ui';

export const AC = {
  measured: '#3D4451',
  judged: '#699BFB',
  judgedInk: '#2451F3',
  warn: '#DC8A00',
  warnInk: '#B54708',
  bad: '#B42318',
  grey: '#C9CCD3',
  track: '#F2F2F4',
  ink: '#0A0A0A',
  faint: '#8F8F8F',
  tier1: '#CCD1DB',
  tier2: '#8DB2FC',
  tier3: '#3D6CE8',
} as const;

/** CSS stripes for an estimate or projection, in a series colour. */
export function stripes(colour: string): string {
  return `repeating-linear-gradient(45deg, ${colour} 0 3px, #ffffff 3px 6px)`;
}

export type AnswerTag = 'measured' | 'judged' | 'estimate';

export function AnswerTagChip({ tag }: { tag: AnswerTag }) {
  if (tag === 'measured') return <span className="inline-block align-[2px] ml-1.5 text-[11px] leading-4 px-1.5 rounded bg-[#E8E9F2] text-[#05073F] whitespace-nowrap">Measured</span>;
  if (tag === 'judged') return <span className="inline-block align-[2px] ml-1.5 text-[11px] leading-4 px-1.5 rounded bg-[#EDF3FF] text-[#2451F3] whitespace-nowrap">AI-judged</span>;
  return <span className="inline-block align-[2px] ml-1.5 text-[11px] leading-4 px-1.5 rounded border border-dashed border-[#699BFB] text-[#2451F3] whitespace-nowrap">Estimate</span>;
}

export interface AttentionItem {
  key?: string;
  label: ReactNode;
  why?: ReactNode;
  /** A small trend beside the item: the last few values, nulls are gaps. */
  spark?: Array<number | null>;
  value?: ReactNode;
  /** Worse than its target: the value reads amber (warn) or red (bad). */
  tone?: 'warn' | 'bad';
  href?: string;
  action?: ReactNode;
}

export interface Attention {
  title: ReactNode;
  items: AttentionItem[];
  /** How many more were left out of the list (shown so nothing is cut silently). */
  more?: number;
}

export function AttentionList({ attention }: { attention: Attention }) {
  if (attention.items.length === 0) return null;
  return (
    <div className="mt-4 pt-3 border-t border-[#EAEAEA]">
      <div className="text-[12px] font-semibold text-[#333333] mb-1">{attention.title}</div>
      {attention.items.map((it, i) => {
        const tone = it.tone === 'bad' ? 'text-[#B42318]' : it.tone === 'warn' ? 'text-[#B54708]' : 'text-[#0A0A0A]';
        const label = it.href && !it.action ? <Link href={it.href} className="text-[#0A0A0A] hover:text-[#245BF3]">{it.label}</Link> : it.label;
        return (
          <div key={it.key ?? i} className="flex items-center gap-3 py-1.5 border-b border-[#F2F2F2] last:border-b-0 text-[13px]">
            <span className="min-w-0 flex-1">{label}{it.why && <span className="text-[#666666]"> {it.why}</span>}</span>
            {it.spark && it.spark.filter(v => v !== null).length >= 2 && (
              <span className="shrink-0 hidden sm:inline-flex"><Spark data={it.spark} tone={it.tone ? 'warn' : 'neutral'} width={80} height={20} /></span>
            )}
            {it.value !== undefined && <span className={cx('shrink-0 tabular-nums whitespace-nowrap text-right', tone)}>{it.value}</span>}
            {it.action && it.href && <Link href={it.href} className="shrink-0 text-[#245BF3] font-medium hover:underline whitespace-nowrap">{it.action}</Link>}
          </div>
        );
      })}
      {attention.more !== undefined && attention.more > 0 && (
        <div className="text-[12px] text-[#8F8F8F] pt-1.5">and {attention.more} more</div>
      )}
    </div>
  );
}

/**
 * A panel in the answer layout. Pass `quiet` (a sentence) when nothing needs attention: the panel
 * then shows only the heading, that sentence, the `strip` if given, and the detail link.
 */
export function AnswerPanel({ question, period, answer, tag, children, legend, attention, detail, note, quiet, strip, right, id, className }: {
  question: ReactNode;
  period?: ReactNode;
  answer?: ReactNode;
  tag?: AnswerTag;
  /** The one chart. */
  children?: ReactNode;
  legend?: LegendItem[];
  attention?: Attention;
  detail?: { href: string; label: ReactNode };
  /** "How it's worked out", one or two lines. */
  note?: ReactNode;
  /** One sentence for the quiet state; when set, the chart and attention list are not shown. */
  quiet?: ReactNode;
  /** A thin strip shown under the quiet sentence, so the panel still reads at a glance. */
  strip?: ReactNode;
  right?: ReactNode;
  id?: string;
  className?: string;
}) {
  const isQuiet = quiet !== undefined && quiet !== null && quiet !== false;
  return (
    <section id={id} className={cx('bg-white border border-[#EAEAEA] rounded-[14px] min-w-0 px-5 py-4 flex flex-col', className)}>
      <div className="flex items-baseline gap-3">
        <h2 className="m-0 text-[14px] font-semibold text-[#0A0A0A] leading-5">{question}</h2>
        <span className="ml-auto flex items-center gap-2 text-[13px] text-[#8F8F8F] whitespace-nowrap">{right}{period}</span>
      </div>
      {isQuiet ? (
        <>
          <p className="m-0 mt-2 text-[15px] leading-6 text-[#333333]">{quiet}{tag && <AnswerTagChip tag={tag} />}</p>
          {strip && <div className="mt-3">{strip}</div>}
        </>
      ) : (
        <>
          {answer && <p className="m-0 mt-2 text-[16px] leading-6 text-[#0A0A0A] [&_b]:font-semibold">{answer}{tag && <AnswerTagChip tag={tag} />}</p>}
          {children && <div className="mt-4">{children}</div>}
          {legend && legend.length > 0 && <Legend items={legend} />}
          {attention && <AttentionList attention={attention} />}
        </>
      )}
      {detail && (
        <div className="mt-3">
          <Link href={detail.href} className="text-[13px] font-medium text-[#245BF3] hover:underline">{detail.label}</Link>
        </div>
      )}
      {note && !isQuiet && (
        <p className="m-0 mt-3 pt-2.5 border-t border-dashed border-[#EAEAEA] text-[12px] leading-[18px] text-[#8F8F8F]">
          How it&apos;s worked out: {note}
        </p>
      )}
    </section>
  );
}

/** Bold figure inside an answer sentence. */
export function Fig({ children }: { children: ReactNode }) {
  return <b className="font-semibold tabular-nums">{children}</b>;
}

/* ── Legend ─────────────────────────────────────────────────────── */

export interface LegendItem { label: ReactNode; colour?: string; striped?: boolean; mark?: 'line' | 'dot' | 'ring' | 'dash' }

export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[12px] text-[#666666]">
      {items.map((it, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          {it.mark === 'line' ? <span className="inline-block w-3 h-[2px]" style={{ background: it.colour }} />
            : it.mark === 'dash' ? <span className="inline-block w-3 border-t-2 border-dashed" style={{ borderColor: it.colour ?? AC.ink }} />
            : it.mark === 'ring' ? <span className="inline-block w-2.5 h-2.5 rounded-full border-2 bg-white" style={{ borderColor: it.colour }} />
            : it.mark === 'dot' ? <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: it.colour }} />
            : <span className="inline-block w-2.5 h-2.5 rounded-[2px]" style={{ background: it.striped ? stripes(it.colour ?? AC.judged) : it.colour, outline: it.striped ? `1px solid ${it.colour ?? AC.judged}` : undefined }} />}
          {it.label}
        </span>
      ))}
    </div>
  );
}

/* ── Columns over time ──────────────────────────────────────────── */

export interface ColumnSeries { label: ReactNode; colour: string; values: Array<number | null> }

/**
 * Columns over time, stacked when there is more than one series. A missing value draws nothing
 * (never a zero-height column that reads as zero). `projectLast` stripes the last column (a
 * projection); `hollowLast` outlines it (a week in progress). `callout` marks the column the
 * answer talks about.
 */
export function Columns({ labels, series, height = 170, yFormat = (v: number) => String(Math.round(v)), yTicks, max: fixedMax,
  target, callout, projectLast, hollowLast, line }: {
  labels: string[];
  series: ColumnSeries[];
  height?: number;
  yFormat?: (v: number) => string;
  yTicks?: number[];
  max?: number;
  target?: { value: number; label: string };
  callout?: { index: number; text: string; judged?: boolean };
  projectLast?: boolean;
  hollowLast?: boolean;
  /** A second measure drawn as a line over the columns, on the same scale. */
  line?: { values: Array<number | null>; colour: string };
}) {
  const uid = useId().replace(/:/g, '');
  const W = 600, top = callout ? 24 : 10, bottom = 20, left = 40, right = 6;
  const H = height - top - bottom, plotW = W - left - right;
  const n = labels.length;
  const totals = labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  const anyValue = labels.map((_, i) => series.some(s => s.values[i] != null));
  const lineMax = line ? Math.max(0, ...line.values.filter((v): v is number => v != null)) : 0;
  const max = fixedMax ?? (Math.max(1, ...totals, lineMax, target?.value ?? 0) * 1.08);
  const gap = n > 16 ? 3 : n > 10 ? 6 : 12;
  const bw = (plotW - gap * (n - 1)) / Math.max(n, 1);
  const y = (v: number) => top + H - (v / max) * H;
  const ticks = yTicks ?? niceTicks(max);
  const labelEvery = n > 14 ? Math.ceil(n / 7) : 1;
  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full h-auto block" role="img">
      {series.map((s, si) => (
        <defs key={si}>
          <pattern id={`${uid}p${si}`} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="#fff" /><rect width="3" height="6" fill={s.colour} />
          </pattern>
        </defs>
      ))}
      {ticks.map(t => (
        <g key={t}>
          <line x1={left} x2={W - right} y1={y(t)} y2={y(t)} stroke="#F0F0F0" />
          <text x={left - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill={AC.faint}>{yFormat(t)}</text>
        </g>
      ))}
      <line x1={left} x2={W - right} y1={top + H} y2={top + H} stroke="#DADADA" />
      {labels.map((lab, i) => {
        const x = left + i * (bw + gap);
        let acc = 0;
        const last = i === n - 1;
        return (
          <g key={i}>
            {anyValue[i] && series.map((s, si) => {
              const v = s.values[i];
              if (v == null || v <= 0) return null;
              const y1 = y(acc + v), h = (v / max) * H;
              acc += v;
              const fill = last && projectLast ? `url(#${uid}p${si})` : last && hollowLast ? '#fff' : s.colour;
              return <rect key={si} x={x} y={y1} width={bw} height={Math.max(h, 0.5)} fill={fill}
                stroke={last && (hollowLast || projectLast) ? s.colour : undefined} strokeWidth={last && hollowLast ? 1.5 : 0.5} />;
            })}
            {!anyValue[i] && <line x1={x} x2={x + bw} y1={top + H - 1} y2={top + H - 1} stroke="#E4E4E7" strokeDasharray="2 2" />}
            {(i % labelEvery === 0 || last) && <text x={x + bw / 2} y={height - 5} textAnchor="middle" fontSize="11" fill={AC.faint}>{lab}</text>}
          </g>
        );
      })}
      {line && <LineOver values={line.values} colour={line.colour} x={i => left + i * (bw + gap) + bw / 2} y={y} />}
      {target && (
        <g>
          <line x1={left} x2={W - right} y1={y(target.value)} y2={y(target.value)} stroke={AC.ink} strokeDasharray="4 3" />
          <text x={W - right} y={y(target.value) - 4} textAnchor="end" fontSize="11" fontWeight="600" fill={AC.ink}>{target.label}</text>
        </g>
      )}
      {callout && callout.index >= 0 && callout.index < n && (() => {
        const x = left + callout.index * (bw + gap) + bw / 2;
        const t = Math.max(totals[callout.index], line?.values[callout.index] ?? 0);
        const anchor = x > W * 0.72 ? 'end' : x < W * 0.2 ? 'start' : 'middle';
        return (
          <g>
            <line x1={x} x2={x} y1={y(t) - 3} y2={top - 6} stroke={AC.ink} />
            <text x={anchor === 'end' ? x + 4 : x} y={top - 10} textAnchor={anchor} fontSize="11" fontWeight="600" fill={callout.judged ? AC.judgedInk : AC.ink}>{callout.text}</text>
          </g>
        );
      })()}
    </svg>
  );
}

function LineOver({ values, colour, x, y }: { values: Array<number | null>; colour: string; x: (i: number) => number; y: (v: number) => number }) {
  const segs: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [];
  values.forEach((v, i) => {
    if (v == null) { if (cur.length) segs.push(cur); cur = []; return; }
    cur.push([x(i), y(v)]);
  });
  if (cur.length) segs.push(cur);
  return (
    <g>
      {segs.map((s, i) => <polyline key={i} points={s.map(p => p.join(',')).join(' ')} fill="none" stroke={colour} strokeWidth={2.5} />)}
      {segs.flat().map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={3} fill="#fff" stroke={colour} strokeWidth={2} />)}
    </g>
  );
}

function niceTicks(max: number): number[] {
  if (max <= 0) return [0];
  const raw = max / 3;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * pow).find(s => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

/* ── Bars against a target, and ranked short lists ─────────────── */

export interface BarRowData { key?: string; label: ReactNode; value: number | null; display: ReactNode; href?: string; colour?: string; striped?: number }

/**
 * Horizontal bars, one row each. With a target, a bar on the wrong side of it turns amber (the
 * only place amber appears). Without a target the bars are one colour: measured or judged.
 * A null value reads "Not measured", never a zero bar.
 */
export function TargetBars({ rows, max, target, tone = 'measured', labelWidth = 140 }: {
  rows: BarRowData[];
  max?: number;
  target?: { value: number; label: string; worse: 'below' | 'above' };
  tone?: 'measured' | 'judged';
  labelWidth?: number;
}) {
  const vals = rows.map(r => r.value ?? 0);
  const top = max ?? Math.max(1, ...vals, target?.value ?? 0) * 1.05;
  const base = tone === 'judged' ? AC.judged : AC.measured;
  return (
    <div className="relative">
      {target && (
        <div className="flex text-[11px] font-semibold text-[#0A0A0A] mb-0.5" style={{ paddingLeft: labelWidth }}>
          <div className="relative flex-1 mr-[84px]"><span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${(target.value / top) * 100}%` }}>{target.label}</span>&nbsp;</div>
        </div>
      )}
      {rows.map((r, i) => {
        const worse = target && r.value != null && (target.worse === 'below' ? r.value < target.value : r.value > target.value);
        const colour = worse ? AC.warn : r.colour ?? base;
        const label = r.href ? <Link href={r.href} className="hover:text-[#245BF3]">{r.label}</Link> : r.label;
        return (
          <div key={r.key ?? i} className="flex items-center gap-2.5 py-[5px] text-[13px]">
            <span className="shrink-0 truncate text-[#333333]" style={{ width: labelWidth - 10 }}>{label}</span>
            <span className="relative flex-1 h-3 rounded-[2px]" style={{ background: AC.track }}>
              {r.value != null && <span className="absolute left-0 top-0 bottom-0 rounded-[2px]" style={{ width: `${Math.max(0.5, Math.min(100, (r.value / top) * 100))}%`, background: colour }} />}
              {r.value != null && r.striped ? (
                <span className="absolute top-0 bottom-0" style={{ left: `${((r.value - r.striped) / top) * 100}%`, width: `${(r.striped / top) * 100}%`, background: stripes(AC.judged) }} />
              ) : null}
              {target && <span className="absolute -top-1 -bottom-1 border-l-2 border-dashed border-[#0A0A0A]" style={{ left: `${(target.value / top) * 100}%` }} />}
            </span>
            <span className={cx('shrink-0 w-[76px] text-right tabular-nums', worse ? 'text-[#B54708] font-semibold' : r.value == null ? 'text-[#8F8F8F]' : 'text-[#0A0A0A]')}>
              {r.value == null ? 'Not measured' : r.display}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ── A split: one bar ───────────────────────────────────────────── */

export interface SplitPart { key?: string; label: ReactNode; value: number; colour: string; striped?: boolean }

export function SplitBar({ parts, height = 22, labels = true }: { parts: SplitPart[]; height?: number; labels?: boolean }) {
  const total = parts.reduce((a, p) => a + Math.max(0, p.value), 0);
  if (total <= 0) return null;
  return (
    <div>
      <div className="flex w-full overflow-hidden rounded-[3px] gap-[2px]" style={{ height }}>
        {parts.filter(p => p.value > 0).map((p, i) => (
          <span key={p.key ?? i} style={{ flex: p.value, background: p.striped ? stripes(p.colour) : p.colour }} title={typeof p.label === 'string' ? p.label : undefined} />
        ))}
      </div>
      {labels && (
        <div className="flex w-full gap-[2px] mt-1">
          {parts.filter(p => p.value > 0).map((p, i) => (
            <span key={p.key ?? i} className="text-[12px] text-[#333333] truncate min-w-0" style={{ flex: p.value }}>{p.value / total >= 0.08 ? p.label : ''}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Two values per row: a person against colleagues, then against now ── */

export function DotCompare({ rows, max, format, labelWidth = 140 }: {
  rows: Array<{ key?: string; label: ReactNode; href?: string; a: number; b: number; display: ReactNode }>;
  max?: number;
  format: (v: number) => string;
  labelWidth?: number;
}) {
  const top = max ?? Math.max(1, ...rows.flatMap(r => [r.a, r.b])) * 1.08;
  return (
    <div>
      {rows.map((r, i) => {
        const pa = (r.a / top) * 100, pb = (r.b / top) * 100;
        const label = r.href ? <Link href={r.href} className="hover:text-[#245BF3]">{r.label}</Link> : r.label;
        return (
          <div key={r.key ?? i} className="flex items-center gap-2.5 py-[7px] text-[13px]">
            <span className="shrink-0 truncate text-[#333333]" style={{ width: labelWidth - 10 }}>{label}</span>
            <span className="relative flex-1 h-4" title={`${format(r.a)} against ${format(r.b)}`}>
              <span className="absolute top-1/2 h-[3px] -translate-y-1/2 bg-[#D4D4D8]" style={{ left: `${Math.min(pa, pb)}%`, width: `${Math.abs(pb - pa)}%` }} />
              <span className="absolute top-1/2 w-3 h-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white border-2 border-[#C9CCD3]" style={{ left: `${pb}%` }} />
              <span className="absolute top-1/2 w-3 h-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#3D4451]" style={{ left: `${pa}%` }} />
            </span>
            <span className="shrink-0 w-[96px] text-right tabular-nums text-[#0A0A0A] font-medium">{r.display}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ── Waterfall: from a starting figure, step by step to the end ──── */

export function Waterfall({ start, steps, end, format, height = 200 }: {
  start: { label: string; value: number; estimate?: boolean };
  steps: Array<{ label: string; value: number }>;
  end: { label: string };
  format: (v: number) => string;
  height?: number;
}) {
  const uid = useId().replace(/:/g, '');
  const W = 600, top = 22, bottom = 34, H = height - top - bottom;
  const finalV = start.value + steps.reduce((a, s) => a + s.value, 0);
  const lo = Math.min(finalV, start.value) * 0.9, hi = Math.max(finalV, start.value) * 1.02;
  const y = (v: number) => top + H - ((v - lo) / (hi - lo)) * H;
  const cols = steps.length + 2, gap = 14, bw = (W - gap * (cols - 1)) / cols;
  let run = start.value;
  const wrap = (s: string) => {
    const words = s.split(' ');
    const half = Math.ceil(words.length / 2);
    return words.length > 2 ? [words.slice(0, half).join(' '), words.slice(half).join(' ')] : [s];
  };
  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full h-auto block" role="img">
      <defs>
        <pattern id={`${uid}s`} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="#fff" /><rect width="3" height="6" fill={AC.judged} />
        </pattern>
      </defs>
      {[start, ...steps, { label: end.label, value: finalV }].map((s, i) => {
        const x = i * (bw + gap);
        const first = i === 0, last = i === cols - 1;
        let y1: number, y2: number, txt: string, tone: string;
        if (first || last) { y1 = y(s.value); y2 = y(lo); txt = format(s.value); tone = AC.ink; }
        else { const a = run, b = run + s.value; y1 = y(Math.max(a, b)); y2 = y(Math.min(a, b)); txt = (s.value < 0 ? '−' : '+') + format(Math.abs(s.value)); tone = AC.judgedInk; run = b; }
        const fill = first && start.estimate ? `url(#${uid}s)` : last ? AC.measured : first ? AC.measured : `url(#${uid}s)`;
        return (
          <g key={i}>
            <rect x={x} y={y1} width={bw} height={Math.max(y2 - y1, 1)} fill={fill} stroke={!first && !last ? AC.judged : first && start.estimate ? AC.judged : undefined} strokeWidth={0.75} />
            <text x={x + bw / 2} y={first || last ? y1 - 6 : y2 + 14} textAnchor="middle" fontSize="11" fontWeight="600" fill={tone}>{txt}</text>
            {wrap(s.label).map((l, li) => <text key={li} x={x + bw / 2} y={height - 18 + li * 13} textAnchor="middle" fontSize="11" fill={AC.faint}>{l}</text>)}
          </g>
        );
      })}
    </svg>
  );
}

/** A thin strip of columns for a quiet panel: the trend at a glance, no axes. */
export function StripColumns({ series, labels }: { series: ColumnSeries[]; labels?: string[] }) {
  return <Columns labels={labels ?? series[0]?.values.map(() => '') ?? []} series={series} height={56} yTicks={[]} />;
}
