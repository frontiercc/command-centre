// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * My Pulse panels: one period at a time (this week, this month or this quarter, each against the
 * same length before), plain statements written here from the figures, one chart colour (petrol).
 * Every figure on the strip opens the work behind it. Spend is the one panel on the calendar
 * month, because Anthropic's limits and FinOps run by month.
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { QuestionCard, shareWords, cap } from '@/components/dashboard/QuestionCard';
import { Frame, Track, linkCls } from '@/components/pulse/WorkPulseOverview';
import {
  depthColumns, depthSentence, gridSentence, DepthChart, DepthSwitch, TierGrid, TierLegend,
  type DepthWindow,
} from '@/components/pulse/DepthChart';
import { PERIOD_SHAPE, type MyPeriod, type PulsePeriod } from '@/lib/pulse/period-shape';

const words = (v: number) => (v < 0.15 ? `${Math.round(v * 100)}%` : shareWords(v));
const hours = (m: number) => { const h = m / 60; return h < 10 ? h.toFixed(1) : Math.round(h).toLocaleString('en-GB'); };
const plural = (c: number, one: string, many: string) => `${c.toLocaleString('en-GB')} ${c === 1 ? one : many}`;
const dateOf = (s: number) => new Date(s * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export interface MonthSpend {
  products: Array<{ label: string; usd: number }>;
  totalUsd: number;
  lastMonthUsd: number | null;
  elapsed: number;
  estimated: boolean;
}

/** Who the page is about, for its sentences: "you" on your own page, the person's name otherwise. */
export interface Who { you: boolean; name: string }
const subj = (w: Who) => (w.you ? 'You' : w.name);
const poss = (w: Who) => (w.you ? 'your' : `${w.name}'s`);

export type DrillKind = 'realwork' | 'tasks' | 'capabilities' | 'humantime';

/* ── The period switch, shared by the strip ───────────────────── */

export function PeriodSwitch({ period, onPeriod }: { period: PulsePeriod; onPeriod: (p: PulsePeriod) => void }) {
  return (
    <span className="inline-flex border border-[#EAEAEA] rounded-[8px] overflow-hidden bg-white">
      {(['week', 'month', 'quarter'] as const).map(p => (
        <button key={p} type="button" onClick={() => onPeriod(p)} className={`text-[12px] px-2 py-0.5 ${p === period ? 'bg-[#F2F2F2] text-[#0A0A0A] font-medium' : 'bg-white text-[#666666]'}`}>
          {PERIOD_SHAPE[p].label}
        </button>
      ))}
    </span>
  );
}

function SeeLink({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} className={`${linkCls} text-left`}>{children}</button>;
}

/* ── 1: Your work ────────────────────────────────────────────── */

export function WorkPanel({ q, product, who, period, onPeriod, onDrill, drill, reviewHref }: {
  q: MyPeriod; product: string; who: Who; period: PulsePeriod; onPeriod: (p: PulsePeriod) => void;
  onDrill: (k: DrillKind | null) => void; drill: DrillKind | null; reviewHref: string | null;
}) {
  const shape = PERIOD_SHAPE[period];
  const r = q.realWork;
  const change = r.beforeAll === 0
    ? `nothing classified ${shape.prior}`
    : r.before === r.now ? `the same as ${shape.prior}` : `${r.now > r.before ? 'up' : 'down'} from ${r.before} ${shape.prior}`;
  const deptLine = r.deptAverage === null ? 'No department average yet.'
    : `${r.now > r.deptAverage * 1.25 ? 'Above' : r.now < r.deptAverage * 0.75 ? 'Below' : 'About'} the department average of ${Math.round(r.deptAverage)}.`;
  const ht = q.humanTime;
  const shareChange = q.share.before === null ? 'nothing to compare with'
    : q.share.now === null ? null
      : Math.round(q.share.now * 100) === Math.round(q.share.before * 100) ? `the same as ${shape.prior}`
        : `${q.share.now > q.share.before ? 'up' : 'down'} from ${words(q.share.before)} ${shape.prior}`;
  return (
    <Frame
      title={who.you ? 'Your work' : `${who.name}'s work`}
      judged
      period={
        <span className="inline-flex items-center gap-2">
          <span>{shape.label} against {shape.prior}</span>
          <PeriodSwitch period={period} onPeriod={onPeriod} />
        </span>
      }
      answer={<>{subj(who)} handed {product} <b>{plural(r.now, 'piece', 'pieces')} of real work</b> {shape.label.toLowerCase()}, {change}.</>}
      note="Real work means a task Claude judged meaningful or frontier, not routine. Click a figure to see the work behind it."
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2.5">
        <QuestionCard
          question={`Real work handed to ${product}`}
          value={`${r.now} of ${r.all}`}
          unit="tasks"
          change={change}
          sub={r.now > 0 ? <SeeLink onClick={() => onDrill(drill === 'realwork' ? null : 'realwork')}>See the {r.now} tasks</SeeLink> : undefined}
          trend={r.trend}
          trendKind="bars"
          notMeasured={r.all === 0 ? `No classified tasks ${shape.label.toLowerCase()}` : undefined}
          todo={deptLine}
        />
        <QuestionCard
          question="How much of it is real work"
          value={q.share.now !== null ? cap(words(q.share.now)) : undefined}
          sub={q.share.now !== null ? <>{plural(r.now, 'of', 'of')} {r.all} tasks{shareChange ? `, ${shareChange}` : ''}</> : undefined}
          trend={q.share.trend}
          notMeasured={q.share.now === null ? `No classified tasks ${shape.label.toLowerCase()}` : undefined}
          todo={r.all > 0 ? <SeeLink onClick={() => onDrill(drill === 'tasks' ? null : 'tasks')}>See all {r.all} tasks</SeeLink> : undefined}
        />
        <QuestionCard
          question={`New ways of working ${who.you ? 'you' : 'they'} started`}
          value={q.capabilities.confirmed}
          unit="confirmed"
          sub={q.capabilities.pending > 0 ? `${q.capabilities.pending} waiting for review` : 'none waiting for review'}
          trend={q.capabilities.trend}
          trendKind="bars"
          todo={q.capabilities.pending > 0 && reviewHref
            ? <Link href={reviewHref} className={linkCls}>Review the {q.capabilities.pending} waiting</Link>
            : q.capabilities.confirmed > 0
              ? <SeeLink onClick={() => onDrill(drill === 'capabilities' ? null : 'capabilities')}>See them</SeeLink>
              : 'Claude flags work that creates something reusable; a manager confirms it.'}
        />
        <QuestionCard
          question="Time it would have taken by hand"
          value={ht ? `≈ ${hours(ht.likelyMinutes)} hours` : undefined}
          sub={ht ? `against ${hours(ht.claudeMinutes)} hours with Claude` : undefined}
          trend={ht?.trend}
          notMeasured={ht ? undefined : `Nothing estimated ${shape.label.toLowerCase()}`}
          todo={ht ? <SeeLink onClick={() => onDrill(drill === 'humantime' ? null : 'humantime')}>See the {ht.sessions} sessions</SeeLink> : undefined}
        />
      </div>
    </Frame>
  );
}

/* ── The work behind a figure ─────────────────────────────────── */

interface TaskRow {
  sessionId?: string; at: number; tier?: number; taskType?: string; text?: string | null;
  description?: string | null; outputs?: string | null; title?: string; status?: string;
  humanMinutes?: number; claudeMinutes?: number;
}
const TIER_WORD = ['', 'Routine', 'Meaningful', 'Frontier'];

export function TaskList({ kind, period, userId, who, onClose }: {
  kind: DrillKind; period: PulsePeriod; userId: string | null; who: Who; onClose: () => void;
}) {
  const [rows, setRows] = useState<TaskRow[] | null>(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    setRows(null);
    const qs = new URLSearchParams({ kind, period });
    if (userId) qs.set('userId', userId);
    fetch(`/api/pulse/me/tasks?${qs}`)
      .then(r => (r.ok ? r.json() : { items: [], textVisible: false }))
      .then(d => { setRows(d.items ?? []); setVisible(!!d.textVisible); })
      .catch(() => setRows([]));
  }, [kind, period, userId]);
  const title = kind === 'capabilities' ? 'New ways of working'
    : kind === 'humantime' ? 'Sessions with a by-hand estimate'
      : kind === 'realwork' ? 'The real work' : 'Every task';
  return (
    <Frame
      title={title}
      period={<button type="button" onClick={onClose} className={linkCls}>Close</button>}
      note={visible ? undefined : `Prompt text is only shown to ${who.you ? 'you' : 'an admin, or a manager in their department'}.`}
    >
      {rows === null && <p className="m-0 text-[13px] text-[#8F8F8F]">Loading.</p>}
      {rows?.length === 0 && <p className="m-0 text-[13px] text-[#8F8F8F]">Nothing in this period.</p>}
      {rows?.map((r, i) => (
        <div key={`${r.sessionId ?? r.title}-${i}`} className="py-2 border-b border-[#F2F2F2] last:border-b-0">
          <p className="m-0 flex items-baseline gap-2 flex-wrap text-[13px]">
            <span className="text-[#8F8F8F] tabular-nums w-[52px] shrink-0">{dateOf(r.at)}</span>
            {r.tier !== undefined && <span className="font-semibold text-[#0A0A0A]">{TIER_WORD[r.tier] ?? `Tier ${r.tier}`}</span>}
            {r.taskType && <span className="text-[#666666]">{cap(r.taskType.replace(/_/g, ' '))}</span>}
            {r.title && <span className="font-semibold text-[#0A0A0A]">{r.title}</span>}
            {r.status && <span className="text-[#666666]">{r.status === 'confirmed' ? 'confirmed' : 'waiting for review'}</span>}
            {r.humanMinutes !== undefined && (
              <span className="text-[#666666]">≈ {hours(r.humanMinutes)} h by hand against {hours(r.claudeMinutes ?? 0)} h with Claude</span>
            )}
          </p>
          {(r.description || r.text) && (
            <p className="m-0 mt-0.5 pl-[60px] text-[13px] leading-5 text-[#444444] line-clamp-2">{r.description ?? r.text}</p>
          )}
          {r.outputs && <p className="m-0 mt-0.5 pl-[60px] text-[12px] text-[#8F8F8F]">Produced {r.outputs}</p>}
        </div>
      ))}
    </Frame>
  );
}

/* ── 3: Is the work getting deeper? ───────────────────────────── */

export function DeeperPanel({ q, who }: { q: MyPeriod; who: Who }) {
  const [window, setWindow] = useState<DepthWindow>(6);
  const cols = depthColumns(q.weeks, window === 6 ? 13 : window, q.end);
  return (
    <Frame
      title={`Is ${poss(who)} work getting deeper?`}
      judged
      period={<DepthSwitch window={window} onWindow={setWindow} />}
      answer={window === 6 ? gridSentence(q.grid, who.you ? 'you handed over' : `${who.name} handed over`) : depthSentence(cols, window, poss(who))}
      note={window === 6 ? 'Each number is a count of tasks that week. The last column is the week in progress.'
        : window === 52 ? 'One column per calendar month.' : 'One column per completed week, Monday to Sunday.'}
    >
      {window === 6 ? <><TierGrid grid={q.grid} /><TierLegend /></> : <DepthChart cols={cols} />}
    </Frame>
  );
}

/* ── 4: What was produced ─────────────────────────────────────── */

export function ProducedPanel({ q, who, period }: { q: MyPeriod; who: Who; period: PulsePeriod }) {
  const p = q.produced;
  const max = Math.max(1, ...p.byKind.map(k => k.files));
  const top = p.byKind.filter(k => k.kind !== 'Other').slice(0, 2).map(k => k.kind.toLowerCase());
  return (
    <Frame
      title={who.you ? 'What you produced' : 'What they produced'}
      period={PERIOD_SHAPE[period].label}
      answer={p.files === 0
        ? <>No files saved, sent or published, from <b>{plural(p.sessions, 'session', 'sessions')}</b>.</>
        : <><b>{plural(p.files, 'file', 'files')}</b> from {plural(p.sessions, 'session', 'sessions')}{top.length ? <>, mostly {top.join(' and ')}</> : null}.</>}
      note="A session produced a file when Claude saved, sent or published one."
    >
      {p.byKind.map(k => (
        <div key={k.kind} className="grid grid-cols-[minmax(0,120px)_minmax(0,1fr)_36px] gap-2.5 items-center py-[3px] text-[13px]">
          <span className="truncate text-[#333333]">{k.kind}</span>
          <Track value={k.files / max} />
          <span className="text-right tabular-nums">{k.files}</span>
        </div>
      ))}
    </Frame>
  );
}

/* ── 5: Skills and connectors colleagues use ──────────────────── */

export function ColleagueToolsPanel({ q, who, department, period }: {
  q: MyPeriod; who: Who; department: string | null; period: PulsePeriod;
}) {
  const t = q.colleagueTools;
  const skills = t.filter(x => x.type === 'skill').length, conns = t.length - skills;
  const parts = [skills ? `${skills} ${skills === 1 ? 'skill' : 'skills'}` : null, conns ? `${conns} ${conns === 1 ? 'connector' : 'connectors'}` : null].filter(Boolean).join(' and ');
  const where = department ? `in ${department}` : 'across the organisation';
  return (
    <Frame
      title="Skills and connectors colleagues use"
      period={PERIOD_SHAPE[period].label}
      answer={t.length === 0
        ? <>{who.you ? 'You use' : `${who.name} uses`} every skill and connector two or more colleagues {where} use.</>
        : <>Colleagues {where} use <b>{parts}</b> {who.you ? "you haven't" : "they haven't"} tried.</>}
      note={q.ownTools.length > 0 ? <>{who.you ? 'Your own' : 'Their own'}: {q.ownTools.join(', ')}.</> : undefined}
    >
      {t.map(x => (
        <div key={`${x.type}:${x.name}`} className="flex items-center gap-2.5 py-1.5 border-b border-[#F2F2F2] last:border-b-0 text-[13px]">
          <span className="min-w-0 truncate text-[#0A0A0A]">{x.name}</span>
          <span className="text-[#777777] whitespace-nowrap">{x.type} · {x.people} colleagues</span>
          {x.libraryId !== null && <Link href={`/library/${x.libraryId}`} className={`${linkCls} ml-auto`}>See it</Link>}
        </div>
      ))}
    </Frame>
  );
}

/* ── 6: Spend, this month ─────────────────────────────────────── */

export function SpendPanel({ s, product, who, reviewHref }: { s: MonthSpend; product: string; who: Who; reviewHref: string | null }) {
  const usd = (v: number) => (v >= 100 ? `$${Math.round(v).toLocaleString('en-GB')}` : `$${v.toFixed(2)}`);
  const pace = s.lastMonthUsd === null ? null : (s.totalUsd / s.elapsed) / s.lastMonthUsd;
  const paceWords = pace === null ? 'There was no spend last month to compare.'
    : pace > 1.15 ? 'ahead of last month’s pace.' : pace < 0.85 ? 'behind last month’s pace.' : 'about the same pace as last month.';
  const max = Math.max(0.01, ...s.products.map(p => p.usd));
  return (
    <Frame
      title={who.you ? 'Your spend' : 'Their spend'}
      period="This month"
      answer={s.totalUsd === 0
        ? <>No spend recorded this month.</>
        : <>{subj(who)} {who.you ? 'have' : 'has'} used <b>{usd(s.totalUsd)}</b> of {product} this month{pace === null ? '. ' : ', '}{paceWords}</>}
      note={<>{s.estimated ? 'Partly estimated at list prices. ' : ''}{reviewHref ? <><Link href={reviewHref} className={linkCls}>{who.you ? 'Your spend review' : 'The spend review'}</Link> has the detail.</> : null}</>}
    >
      {s.products.map(p => (
        <div key={p.label} className="grid grid-cols-[minmax(0,120px)_minmax(0,1fr)_60px] gap-2.5 items-center py-[3px] text-[13px]">
          <span className="truncate text-[#333333]">{p.label}</span>
          <Track value={p.usd / max} />
          <span className="text-right tabular-nums">{usd(p.usd)}</span>
        </div>
      ))}
    </Frame>
  );
}
