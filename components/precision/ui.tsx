// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Precision UI kit: the building blocks every page uses, styled to the approved mockups
 * (canvas "Command Centre style options", Components artboard).
 *
 * Rules the kit encodes:
 *  - grey page (#F7F7F8), white panels with a 1px #EAEAEA border and 8px corners
 *  - 13px body text, 12px captions in #8F8F8F, panel titles 13px semibold ink
 *  - dark blue (#05073F) = measured, sky blue (#699BFB, #2451F3 text) = AI-judged or estimate;
 *    vibrant blue (#245BF3) is for links and actions only
 *  - figures use tabular numbers; never render a missing value as 0
 * Client-safe, no data fetching. Import from '@/components/precision/ui'.
 */
import type { ReactNode } from 'react';

export const C = {
  ink: '#0A0A0A',
  ink2: '#333333',
  ink3: '#4D4D4D',
  mute: '#666666',
  faint: '#8F8F8F',
  line: '#EAEAEA',
  line2: '#F2F2F2',
  input: '#DADADA',
  subtle: '#FAFAFA',
  page: '#F7F7F8',
  accent: '#245BF3',
  measured: '#05073F',
  measuredLight: '#8C96BF',
  accentHover: '#1A44C7',
  accentTint: '#F2F5FF',
  judged: '#699BFB',
  judgedInk: '#2451F3',
  judgedTint: '#EDF3FF',
  good: '#1A7F37',
  bad: '#B42318',
  warn: '#B54708',
  high: '#D92D20',
  medium: '#DC8A00',
} as const;

export type Tone = 'measured' | 'judged' | 'neutral' | 'good' | 'bad' | 'warn';

const toneText: Record<Tone, string> = {
  measured: 'text-[#05073F]',
  judged: 'text-[#2451F3]',
  neutral: 'text-[#0A0A0A]',
  good: 'text-[#1A7F37]',
  bad: 'text-[#B42318]',
  warn: 'text-[#B54708]',
};
const toneBar: Record<Tone, string> = {
  measured: 'bg-[#3D4451]', // percentage and share bars are charcoal (SHARE_BAR in lib/ui/chart-colours)
  judged: 'bg-[#699BFB]',
  neutral: 'bg-[#0A0A0A]',
  good: 'bg-[#1A7F37]',
  bad: 'bg-[#B42318]',
  warn: 'bg-[#DC8A00]',
};

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/* ── Page body ─────────────────────────────────────────────────────── */

/** The padded column under the page header. Full width, like the original layout:
 *  a fixed cap left a wide empty band on large screens. `wide` is kept for callers and no longer changes anything. */
export function PageBody({ children, className }: { children: ReactNode; wide?: boolean; className?: string }) {
  return (
    <div className={cx('px-6 lg:px-8 pt-4 pb-10 flex flex-col gap-4 w-full', className)}>
      {children}
    </div>
  );
}

/** A row above the content: page-level controls on the right, a caption on the left. */
export function Toolbar({ left, children }: { left?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 flex-wrap min-h-[32px]">
      {left && <div className="text-[13px] text-[#8F8F8F]">{left}</div>}
      <div className="ml-auto flex items-center gap-2 flex-wrap">{children}</div>
    </div>
  );
}

/* ── Panels ────────────────────────────────────────────────────────── */

export function Panel({ title, subtitle, right, badge, children, className, bodyClassName, flush = false, id }: {
  title?: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  badge?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Body without padding: tables and row lists run edge to edge. */
  flush?: boolean;
  id?: string;
}) {
  return (
    <section id={id} className={cx('bg-white border border-[#EAEAEA] rounded-[14px] min-w-0', className)}>
      {(title || right) && (
        <div className="flex items-center gap-x-3 gap-y-1 flex-wrap px-4 py-3 border-b border-[#EAEAEA]">
          {title && <h2 className="m-0 text-[14px] font-semibold text-[#0A0A0A] leading-5">{title}</h2>}
          {badge}
          {subtitle && <span className="text-[13px] text-[#8F8F8F]">{subtitle}</span>}
          {right && <div className="ml-auto flex items-center gap-2 flex-wrap">{right}</div>}
        </div>
      )}
      <div className={cx(flush ? '' : 'p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

/** A footnote strip at the bottom of a panel. Put it inside a flush Panel. */
export function PanelFoot({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return (
    <div className={cx('px-4 py-2.5 border-t border-[#F2F2F2] text-[13px]', tone === 'neutral' ? 'text-[#8F8F8F]' : toneText[tone])}>
      {children}
    </div>
  );
}

/** A sub-heading inside a panel body. */
export function SubHead({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 mb-2">
      <span className="text-[13px] font-medium text-[#666666]">{children}</span>
      {right && <span className="ml-auto">{right}</span>}
    </div>
  );
}

/* ── Figures ───────────────────────────────────────────────────────── */

/** Headline figures joined into one panel with hairline dividers. */
export function Strip({ children, cols }: { children: ReactNode; cols?: 2 | 3 | 4 | 5 | 6 }) {
  const grid = {
    2: 'sm:grid-cols-2',
    3: 'sm:grid-cols-3',
    4: 'sm:grid-cols-2 lg:grid-cols-4',
    5: 'sm:grid-cols-3 lg:grid-cols-5',
    6: 'sm:grid-cols-3 lg:grid-cols-6',
  }[cols ?? 4];
  return (
    <div className={cx('grid grid-cols-1 bg-white border border-[#EAEAEA] rounded-[14px] overflow-hidden', grid,
      '[&>*]:border-[#EAEAEA] [&>*+*]:border-t sm:[&>*+*]:border-t-0 sm:[&>*+*]:border-l')}>
      {children}
    </div>
  );
}

export function Figure({ label, value, sub, tone = 'neutral', unit, delta, deltaTone, title }: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  unit?: ReactNode;
  delta?: ReactNode;
  deltaTone?: Tone;
  title?: string;
}) {
  return (
    <div className="p-4 flex flex-col gap-1.5 min-w-0" title={title}>
      <span className="text-[13px] text-[#666666]">{label}</span>
      <span className={cx('text-[24px] leading-7 font-semibold tracking-[-0.02em] tabular-nums', tone === 'judged' ? 'text-[#05073F]' : toneText[tone])}>
        {value}{unit && <span className="text-[14px] font-normal text-[#8F8F8F] tracking-normal"> {unit}</span>}
      </span>
      {delta && <span className={cx('text-[13px] tabular-nums', deltaTone ? toneText[deltaTone] : 'text-[#8F8F8F]')}>{delta}</span>}
      {sub && <span className="text-[13px] text-[#8F8F8F]">{sub}</span>}
    </div>
  );
}

/** Tone for a signed change: up is good unless `upIsBad`. */
export function deltaTone(diff: number | null | undefined, upIsBad = false): Tone {
  if (diff === null || diff === undefined || Math.abs(diff) < 1e-9) return 'neutral';
  const up = diff > 0;
  return up !== upIsBad ? 'good' : 'bad';
}

/* ── Rows, bars and tables ─────────────────────────────────────────── */

/** A labelled row with a thin bar underneath (top skills, work mix, output by kind). */
export function BarRow({ label, value, pct, tone = 'measured', title, rank, color }: {
  label: ReactNode; value: ReactNode; pct: number; tone?: Tone; title?: string; rank?: number;
  /** Series colour (e.g. a surface colour); overrides tone. */
  color?: string;
}) {
  return (
    <div className="px-4 py-2 border-t border-[#F2F2F2] first:border-t-0 flex flex-col gap-1" title={title}>
      <div className="flex items-baseline gap-2 min-w-0">
        {rank !== undefined && <span className="text-[12px] text-[#B3B3B3] w-4 shrink-0 tabular-nums">{rank}</span>}
        <span className="text-[14px] text-[#0A0A0A] truncate">{label}</span>
        <span className="ml-auto text-[13px] text-[#666666] tabular-nums whitespace-nowrap">{value}</span>
      </div>
      <Bar pct={pct} tone={tone} color={color} />
    </div>
  );
}

export function Bar({ pct, tone = 'measured', height = 3, color }: { pct: number; tone?: Tone; height?: 3 | 4 | 6 | 8; color?: string }) {
  const h = { 3: 'h-[3px]', 4: 'h-1', 6: 'h-1.5', 8: 'h-2' }[height];
  const w = Math.max(0, Math.min(100, pct));
  return (
    <div className={cx('w-full rounded-full bg-[#F2F2F2] overflow-hidden', h)}>
      <div className={cx('h-full rounded-full', !color && toneBar[tone])} style={{ width: `${w}%`, ...(color ? { background: color } : {}) }} />
    </div>
  );
}

/** Table class names: use with a plain <table className={T.table}>. */
export const T = {
  table: 'w-full border-collapse text-[14px]',
  headRow: 'text-left text-[13px] text-[#8F8F8F]',
  th: 'font-medium px-2 py-2 first:pl-4 last:pr-4 whitespace-nowrap',
  thRight: 'font-medium px-2 py-2 first:pl-4 last:pr-4 text-right whitespace-nowrap',
  row: 'border-t border-[#F2F2F2] hover:bg-[#FAFAFA]',
  td: 'px-2 py-2.5 first:pl-4 last:pr-4 align-middle',
  tdRight: 'px-2 py-2.5 first:pl-4 last:pr-4 align-middle text-right tabular-nums',
  tdMute: 'px-2 py-2.5 first:pl-4 last:pr-4 align-middle text-[#666666]',
};

/* ── Small parts ───────────────────────────────────────────────────── */

/** Mono tag: surfaces (CODE, COWORK), kinds (PROCESS), counts (2 ROUTES). */
export function Tag({ children, tone = 'neutral', title }: { children: ReactNode; tone?: 'neutral' | 'measured' | 'judged' | 'warn' | 'bad'; title?: string }) {
  const cls = {
    neutral: 'border border-[#EAEAEA] text-[#4D4D4D]',
    measured: 'bg-[#E8E9F2] text-[#05073F]',
    judged: 'bg-[#EDF3FF] text-[#2451F3]',
    warn: 'bg-[#FFF4E5] border border-[#F5D9A8] text-[#8A5300]',
    bad: 'bg-[#FFF5F4] border border-[#F3C0BB] text-[#B42318]',
  }[tone];
  return (
    <span title={title} className={cx('inline-flex items-center font-mono text-[11px] leading-4 px-2 py-px rounded-full uppercase tracking-normal whitespace-nowrap', cls)}>
      {children}
    </span>
  );
}

/** Soft pill for statuses (lifecycle, health). */
export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'info' | 'warn' | 'bad' | 'judged' }) {
  const cls = {
    neutral: 'bg-[#F2F2F2] text-[#4D4D4D]',
    good: 'bg-[#E7F6EC] text-[#146C2E]',
    info: 'bg-[#EAF0FE] text-[#1A44C7]',
    warn: 'bg-[#FFF1E0] text-[#8A5300]',
    bad: 'bg-[#FFF5F4] text-[#B42318]',
    judged: 'bg-[#EDF3FF] text-[#2451F3]',
  }[tone];
  return <span className={cx('inline-flex items-center text-[12px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap', cls)}>{children}</span>;
}

/** Status dot with label (severity, signal status). */
export function Dot({ color, children }: { color: string; children?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px]">
      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
      {children}
    </span>
  );
}

export const SEVERITY_COLOR: Record<string, string> = {
  critical: '#7A271A', high: '#D92D20', medium: '#DC8A00', low: '#A3A3A3',
};

/** Button class names. */
export const B = {
  primary: 'inline-flex items-center justify-center gap-1.5 text-[13px] font-medium px-3 py-1.5 rounded-[10px] bg-[#0A0A0A] text-white hover:bg-[#262626] disabled:opacity-50 disabled:cursor-not-allowed',
  accent: 'inline-flex items-center justify-center gap-1.5 text-[13px] font-medium px-3 py-1.5 rounded-[10px] bg-[#245BF3] text-white hover:bg-[#1A44C7] disabled:opacity-50 disabled:cursor-not-allowed',
  secondary: 'inline-flex items-center justify-center gap-1.5 text-[13px] font-medium px-3 py-1.5 rounded-[10px] border border-[#DADADA] bg-white text-[#0A0A0A] hover:bg-[#FAFAFA] disabled:opacity-50 disabled:cursor-not-allowed',
  danger: 'inline-flex items-center justify-center gap-1.5 text-[13px] font-medium px-3 py-1.5 rounded-[10px] border border-[#F3C0BB] bg-white text-[#B42318] hover:bg-[#FFF5F4] disabled:opacity-50 disabled:cursor-not-allowed',
  link: 'text-[13px] font-medium text-[#245BF3] hover:underline disabled:opacity-50',
  input: 'text-[14px] px-2.5 py-1.5 rounded-[10px] border border-[#DADADA] bg-white text-[#0A0A0A] placeholder:text-[#8F8F8F] focus:outline-none focus:ring-2 focus:ring-[#245BF3]/30 focus:border-[#245BF3]',
  select: 'text-[13px] px-2 py-1.5 rounded-[10px] border border-[#DADADA] bg-white text-[#0A0A0A] focus:outline-none focus:ring-2 focus:ring-[#245BF3]/30',
};

/** Segmented control (period / window / status filters). */
export function Segmented<T extends string | number>({ options, value, onChange, label }: {
  options: Array<{ value: T; label: ReactNode }>;
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex border border-[#EAEAEA] rounded-[10px] overflow-hidden bg-white">
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cx('text-[13px] px-2.5 py-1', i > 0 && 'border-l border-[#EAEAEA]',
              on ? 'bg-[#F2F2F2] text-[#0A0A0A] font-medium' : 'bg-white text-[#666666] hover:text-[#0A0A0A]')}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Underline tabs (admin sub-sections, Skills/Connectors). */
export function Tabs<T extends string>({ tabs, value, onChange, label }: {
  tabs: Array<{ value: T; label: ReactNode }>;
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-5 border-b border-[#EAEAEA] overflow-x-auto overflow-y-hidden">
      {tabs.map(t => {
        const on = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.value)}
            className={cx('text-[14px] py-2 -mb-px border-b-2 whitespace-nowrap',
              on ? 'border-[#0A0A0A] text-[#0A0A0A] font-medium' : 'border-transparent text-[#666666] hover:text-[#0A0A0A]')}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/** Toggle chip (filters). */
export function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cx('text-[13px] px-2.5 py-1 rounded-[10px] border',
        on ? 'border-[#245BF3] bg-[#F2F5FF] text-[#245BF3] font-medium' : 'border-[#EAEAEA] bg-white text-[#4D4D4D] hover:border-[#DADADA]')}
    >
      {children}
    </button>
  );
}

export function Notice({ tone = 'info', title, children, action }: {
  tone?: 'info' | 'warn' | 'error' | 'success'; title?: ReactNode; children?: ReactNode; action?: ReactNode;
}) {
  const cls = {
    info: 'border-[#C9D6FD] bg-[#F5F8FF] text-[#333333]',
    warn: 'border-[#F5D9A8] bg-[#FFFAF0] text-[#5C3A00]',
    error: 'border-[#F3C0BB] bg-[#FFF5F4] text-[#7A271A]',
    success: 'border-[#B7E4C7] bg-[#F1FBF4] text-[#14532D]',
  }[tone];
  return (
    <div className={cx('border rounded-[14px] px-3.5 py-2.5 text-[14px] leading-5 flex items-start gap-3', cls)}>
      <div className="min-w-0 flex-1">{title && <span className="font-semibold">{title} </span>}{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function Empty({ title, children, action, icon }: { title: ReactNode; children?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="border border-dashed border-[#DADADA] bg-white rounded-[14px] px-6 py-8 text-center flex flex-col items-center gap-1.5">
      {icon && <span className="text-[22px] leading-none mb-1" aria-hidden="true">{icon}</span>}
      <span className="text-[14px] font-medium text-[#0A0A0A]">{title}</span>
      {children && <span className="text-[13px] text-[#8F8F8F] max-w-md">{children}</span>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

/** Small italic-free placeholder line used inside panels. */
export function Muted({ children }: { children: ReactNode }) {
  return <p className="m-0 text-[13px] text-[#8F8F8F]">{children}</p>;
}

/** Thin SVG sparkline for a numeric series; nulls are gaps. */
export function Spark({ data, tone = 'measured', width = 72, height = 20, fixedMin, fixedMax }: {
  data: Array<number | null>; tone?: Tone; width?: number; height?: number;
  /** Fix the scale (e.g. 0 and 1 for a share) so a small drift is not drawn as dramatic growth. */
  fixedMin?: number; fixedMax?: number;
}) {
  const vals = data.filter((v): v is number => v !== null && Number.isFinite(v));
  if (vals.length < 2) return <span className="text-[12px] text-[#B3B3B3]">—</span>;
  const max = fixedMax ?? Math.max(...vals), min = fixedMin ?? Math.min(...vals), span = max - min || 1;
  const step = data.length > 1 ? width / (data.length - 1) : width;
  const stroke = tone === 'judged' ? '#699BFB' : tone === 'neutral' ? '#8F8F8F' : '#05073F';
  const segs: string[] = [];
  let cur: string[] = [];
  data.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) { if (cur.length) segs.push(cur.join(' ')); cur = []; return; }
    cur.push(`${(i * step).toFixed(1)},${(height - 2 - ((v - min) / span) * (height - 4)).toFixed(1)}`);
  });
  if (cur.length) segs.push(cur.join(' '));
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {segs.map((s, i) => <polyline key={i} points={s} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />)}
    </svg>
  );
}
