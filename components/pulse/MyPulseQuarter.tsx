// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * My Pulse panels on the quarterly timeline: one period (the last quarter against the quarter
 * before), plain statements written here from the figures, one chart colour (petrol). Spend is
 * the one panel on the calendar month. Shared with the Users drill-down (a person's page).
 */
import Link from 'next/link';
import { useState } from 'react';
import { QuestionCard, shareWords, cap } from '@/components/dashboard/QuestionCard';
import { Frame, Track, linkCls } from '@/components/pulse/WorkPulseOverview';
import { depthColumns, depthSentence, DepthChart, DepthSwitch, type DepthWindow } from '@/components/pulse/DepthChart';
import type { MyQuarter } from '@/lib/pulse/my-quarter';
import type { FrontierView } from '@/lib/pulse/frontier-view';

const words = (v: number) => (v < 0.15 ? `${Math.round(v * 100)}%` : shareWords(v));
const hours = (m: number) => { const h = m / 60; return h < 10 ? h.toFixed(1) : Math.round(h).toLocaleString('en-GB'); };
const TIER = ['', 'Routine', 'Meaningful', 'Frontier'];

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

/* ── 1: The quarter ──────────────────────────────────────────── */

export function QuarterPanel({ q, frontier, product, who, reviewHref }: {
  q: MyQuarter; frontier: FrontierView | null; product: string; who: Who; reviewHref: string | null;
}) {
  const r = q.realWork;
  const best = frontier?.bestWork?.[0] ?? null;
  const change = r.before === r.now ? 'the same as the quarter before' : `${r.now > r.before ? 'up' : 'down'} from ${r.before} the quarter before`;
  const deptLine = r.deptAverage === null ? null
    : r.now > r.deptAverage * 1.25 ? 'Above average for the department.'
      : r.now < r.deptAverage * 0.75 ? 'Below average for the department.'
        : 'About average for the department.';
  const shareLine = q.share.now === null ? null
    : q.share.before === null || Math.round(q.share.now * 100) === Math.round(q.share.before * 100)
      ? <>Real work is {words(q.share.now)} of {poss(who)} tasks this quarter.</>
      : <>Real work is {words(q.share.now)} of {poss(who)} tasks this quarter, {q.share.now > q.share.before ? 'up' : 'down'} from {words(q.share.before)}.</>;
  const ht = q.humanTime;
  return (
    <Frame
      title={who.you ? 'Your quarter' : 'Their quarter'}
      judged
      period="Last quarter against the quarter before"
      answer={<>{subj(who)} handed {product} <b>{r.now} {r.now === 1 ? 'piece' : 'pieces'} of real work</b> this quarter, {change.replace(' the quarter before', '')}.{best ? <> {who.you ? 'Your' : 'Their'} deepest piece this week was {TIER[best.tier]?.toLowerCase()} work.</> : null}</>}
      note="Real work means a task Claude judged meaningful or frontier, not routine. Every figure covers the last quarter; the bars and lines show it week by week."
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2.5">
        <QuestionCard
          question={`Real work handed to ${product}`}
          value={`${r.now} of ${r.all}`}
          unit="tasks"
          change={change}
          trend={r.weekly}
          trendKind="bars"
          notMeasured={r.all === 0 ? 'No classified tasks this quarter' : undefined}
          todo={deptLine}
        />
        <QuestionCard
          question="Deepest work this week"
          value={best ? TIER[best.tier] : 'None yet'}
          sub={best ? (best.description ?? cap(best.taskType.replace(/_/g, ' '))) : 'No classified work in the last 7 days'}
          trend={q.share.weekly}
          todo={shareLine}
        />
        <QuestionCard
          question={`New ways of working ${who.you ? 'you' : 'they'} started`}
          value={q.capabilities.confirmed}
          unit="confirmed"
          sub={q.capabilities.pending > 0 ? `${q.capabilities.pending} waiting for review` : 'none waiting for review'}
          trend={q.capabilities.weekly}
          trendKind="bars"
          todo={q.capabilities.pending > 0 && reviewHref
            ? <Link href={reviewHref} className={linkCls}>Review the {q.capabilities.pending === 1 ? '1' : q.capabilities.pending} waiting</Link>
            : 'Claude flags work that creates something reusable; a manager confirms it.'}
        />
        <QuestionCard
          question="Time it would have taken by hand"
          value={ht ? `≈ ${hours(ht.likelyMinutes)} hours` : undefined}
          sub={ht ? `against ${hours(ht.claudeMinutes)} hours with Claude` : undefined}
          trend={ht?.weekly}
          notMeasured={ht ? undefined : 'No estimated sessions this quarter'}
          todo={ht ? 'An estimate by Claude, not measured.' : undefined}
        />
      </div>
    </Frame>
  );
}

/* ── 2: Is the work getting deeper? ─────────────────────────────── */

export function DeeperPanel({ q, who }: { q: MyQuarter; who: Who }) {
  const [window, setWindow] = useState<DepthWindow>(13);
  const cols = depthColumns(q.weeks, window, q.quarterEnd);
  return (
    <Frame
      title={`Is ${poss(who)} work getting deeper?`}
      judged
      period={<DepthSwitch window={window} onWindow={setWindow} />}
      answer={depthSentence(cols, window, poss(who))}
      note={window === 52 ? 'One column per calendar month.' : 'One column per completed week, Monday to Sunday.'}
    >
      <DepthChart cols={cols} />
    </Frame>
  );
}

/* ── 3: What was produced ────────────────────────────────────── */

export function ProducedPanel({ q, who }: { q: MyQuarter; who: Who }) {
  const p = q.produced;
  const max = Math.max(1, ...p.byKind.map(k => k.files));
  const top = p.byKind.filter(k => k.kind !== 'Other').slice(0, 2).map(k => k.kind.toLowerCase());
  return (
    <Frame
      title={who.you ? 'What you produced' : 'What they produced'}
      period="Last quarter"
      answer={p.files === 0
        ? <>No files saved, sent or published this quarter, from <b>{p.sessions} {p.sessions === 1 ? 'session' : 'sessions'}</b>.</>
        : <><b>{p.files} {p.files === 1 ? 'file' : 'files'}</b> from {p.sessions} {p.sessions === 1 ? 'session' : 'sessions'}{top.length ? <>, mostly {top.join(' and ')}</> : null}.</>}
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

/* ── 4: Skills and connectors colleagues use ─────────────────────── */

export function ColleagueToolsPanel({ q, who, department }: { q: MyQuarter; who: Who; department: string | null }) {
  const t = q.colleagueTools;
  const skills = t.filter(x => x.type === 'skill').length, conns = t.length - skills;
  const parts = [skills ? `${skills} ${skills === 1 ? 'skill' : 'skills'}` : null, conns ? `${conns} ${conns === 1 ? 'connector' : 'connectors'}` : null].filter(Boolean).join(' and ');
  const where = department ? `in ${department}` : 'across the organisation';
  return (
    <Frame
      title="Skills and connectors colleagues use"
      period="Last quarter"
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

/* ── 5: Spend, this month ─────────────────────────────────────── */

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
