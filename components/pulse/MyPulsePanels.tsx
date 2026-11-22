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
import { QuestionCard, shareWords, sharePair, cap } from '@/components/dashboard/QuestionCard';
import { B, Muted, LOAD_FAILED } from '@/components/precision/ui';
import { Frame, Track, linkCls } from '@/components/pulse/WorkPulseOverview';
import {
  depthColumns, depthSentence, gridSentence, DepthChart, DepthSwitch, TierGrid, TierLegend,
  type DepthWindow,
} from '@/components/pulse/DepthChart';
import { PERIOD_SHAPE, type MyPeriod, type PulsePeriod } from '@/lib/pulse/period-shape';
import type { Vendor } from '@/lib/dashboard/vendor';
import { deepWords, DeepWords, tierList, tierNamesOr, type TierNames } from '@/lib/pulse/tier-names';
import { NEW_WAYS_OF_WORKING } from '@/lib/pulse/cowork/coaching-words';
import { humanTimeKindLabel } from '@/components/pulse/HumanTimeCard';
import { useSessionRole } from '@/components/shared/useSessionRole';
import { skillLabel, connectorLabel } from '@/components/dashboard/tool-names';

const words = (v: number) => (v < 0.15 ? `${Math.round(v * 100)}%` : shareWords(v));
const hours = (m: number) => { const h = m / 60; return h < 10 ? h.toFixed(1) : Math.round(h).toLocaleString('en-GB'); };
/** A count with en-GB thousands separators. */
const num = (c: number) => c.toLocaleString('en-GB');
const plural = (c: number, one: string, many: string) => `${num(c)} ${c === 1 ? one : many}`;
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

export function WorkPanel({ q, product, who, period, onPeriod, onDrill, drill, reviewHref, names }: {
  q: MyPeriod; product: string; who: Who; period: PulsePeriod; onPeriod: (p: PulsePeriod) => void;
  onDrill: (k: DrillKind | null) => void; drill: DrillKind | null; reviewHref: string | null; names?: TierNames;
}) {
  const shape = PERIOD_SHAPE[period];
  const deep = deepWords(names);
  const t = tierNamesOr(names);
  const r = q.realWork;
  // Nothing judged in the period before (none kept, or no work then): no comparison is made.
  const change = r.beforeAll === 0
    ? null
    : r.before === r.now ? `the same as ${shape.prior}` : `${r.now > r.before ? 'up' : 'down'} from ${num(r.before)} ${shape.prior}`;
  // A department's page sets its share beside the rest of the organisation's; a person's page
  // sets their count beside their department's per-person average.
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const deptLine = r.orgShare !== undefined
    ? (r.orgShare === null || r.all === 0
      ? 'Not enough work judged elsewhere yet to compare.'
      : `${pct(r.now / r.all)} of ${who.name}'s tasks are ${deep}, against ${pct(r.orgShare)} across the rest of the organisation.`)
    : r.deptAverage === null ? 'No department average yet.'
      : `${r.now > r.deptAverage * 1.25 ? 'More than' : r.now < r.deptAverage * 0.75 ? 'Fewer than' : 'About the same as'} the average person in ${who.you ? 'your' : 'their'} department, who handed over ${plural(Math.round(r.deptAverage), `task judged ${deep}`, `tasks judged ${deep}`)}.`;
  // Nothing before to compare with: say nothing rather than filling the line with it.
  const shareChange = q.share.before === null || q.share.now === null ? null
      : Math.round(q.share.now * 100) === Math.round(q.share.before * 100) ? `the same as ${shape.prior}`
        : `${q.share.now > q.share.before ? 'up' : 'down'} from ${sharePair(q.share.now, q.share.before)[1]} ${shape.prior}`;
  return (
    <Frame
      title={who.you ? 'Your work' : `${who.name}'s work`}
      judged
      period={
        <span className="inline-flex items-center gap-2">
          <span>{change === null ? shape.label : `${shape.label} against ${shape.prior}`}</span>
          <PeriodSwitch period={period} onPeriod={onPeriod} />
        </span>
      }
      answer={<>{subj(who)} handed {product} <b>{r.now === 0 ? 'no tasks' : plural(r.now, 'task', 'tasks')} judged {deep}</b> {shape.label.toLowerCase()}{change ? <>, {change}</> : null}.</>}
      note={<>{t.t2} and {t.t3} are the top two tiers Claude judges each task against; the rest are {t.t1.toLowerCase()}. Click a figure to see the work behind it.</>}
    >
      <div className={`grid grid-cols-1 sm:grid-cols-${q.people ? '2 xl:grid-cols-4' : '3'} gap-2.5`}>
        {q.people && (
          <QuestionCard
            question={`People doing ${deep} work`}
            value={`${num(q.people.deep)} of ${num(q.people.active)}`}
            unit="people"
            sub={q.people.active > q.people.deep
              ? `${num(q.people.active - q.people.deep)} only did ${t.t1.toLowerCase()} work`
              : 'everyone active did some'}
            notMeasured={q.people.active === 0 ? `Nobody active ${shape.label.toLowerCase()}` : undefined}
            todo="Counts people with any classified task in the period."
          />
        )}
        <QuestionCard
          question={`Tasks judged ${deep}`}
          value={`${num(r.now)} of ${num(r.all)}`}
          unit="tasks"
          change={change ?? undefined}
          sub={r.now > 0 ? <SeeLink onClick={() => onDrill(drill === 'realwork' ? null : 'realwork')}>See the {num(r.now)} tasks</SeeLink> : undefined}
          trend={r.trend}
          trendKind="bars"
          notMeasured={r.all === 0 ? `No classified tasks ${shape.label.toLowerCase()}` : undefined}
          todo={deptLine}
        />
        <QuestionCard
          question={`How much is ${deep}`}
          value={q.share.now !== null ? cap(words(q.share.now)) : undefined}
          sub={q.share.now !== null ? <>{plural(r.now, 'of', 'of')} {num(r.all)} tasks{shareChange ? `, ${shareChange}` : ''}</> : undefined}
          trend={q.share.trend}
          notMeasured={q.share.now === null ? `No classified tasks ${shape.label.toLowerCase()}` : undefined}
          todo={r.all > 0 ? <SeeLink onClick={() => onDrill(drill === 'tasks' ? null : 'tasks')}>See all {num(r.all)} tasks</SeeLink> : undefined}
        />
        <QuestionCard
          question={`New ways of working ${who.you ? 'you' : 'they'} started`}
          value={num(q.capabilities.confirmed)}
          unit="confirmed"
          sub={q.capabilities.pending > 0 ? `${num(q.capabilities.pending)} waiting for review` : 'none waiting for review'}
          trend={q.capabilities.trend}
          trendKind="bars"
          todo={q.capabilities.pending > 0 && reviewHref
            ? <Link href={reviewHref} className={linkCls}>Review the {num(q.capabilities.pending)} waiting</Link>
            : q.capabilities.confirmed > 0
              ? <SeeLink onClick={() => onDrill(drill === 'capabilities' ? null : 'capabilities')}>See them</SeeLink>
              : NEW_WAYS_OF_WORKING}
        />
      </div>
    </Frame>
  );
}

/* ── By hand vs with the AI that was counted ──────────────────── */

export interface ByHand {
  windowDays: number;
  sessions: number;
  humanMinutes: { low: number; likely: number; high: number };
  claudeMinutes: number;
  ratio: number | null;
  byKind: Array<{ kind: string; sessions: number; humanMinutes: number; claudeMinutes: number }>;
  /** Every session with no row of its own (lib/pulse/human-time-summary.ts). */
  otherKinds?: { kind: string; sessions: number; humanMinutes: number; claudeMinutes: number };
  check?: { period: string; reviewed: number; aboutRight: number } | null;
}

/**
 * `tool` names what the "with" side counts, so the title is never wrong: Claude, ChatGPT or AI on
 * Work Pulse, Claude Code, Codex or AI on Developer Pulse. Claude when not given. `surface` names
 * the kinds of work as HumanTimeCard does: Work Pulse's pages pass 'cowork', Developer Pulse's
 * leave it out.
 */
export function ByHandPanel({ h, who, onSeeSessions, tool = 'Claude', surface = 'code' }: {
  h: ByHand | null | undefined; who: Who; onSeeSessions?: () => void; tool?: string; surface?: 'code' | 'cowork';
}) {
  // Off, or not this viewer's to see: no panel. On with no sessions: say so.
  if (!h) return null;
  if (h.sessions === 0) return (
    <Frame title={`By hand vs with ${tool}`}>
      <Muted>No sessions with a by-hand estimate yet.</Muted>
    </Frame>
  );
  const whose = who.you ? 'your work' : `${who.name}'s work`;
  const longer = h.ratio === null ? null
    : h.ratio >= 1.8 && h.ratio < 2.5 ? 'about twice as long'
      : h.ratio >= 2.5 && h.ratio < 3.5 ? 'about three times as long'
        : h.ratio >= 1.2 ? `about ${Math.round(h.ratio)} times as long` : null;
  const kinds = [...h.byKind].sort((a, b) => b.humanMinutes - a.humanMinutes).slice(0, 4)
    .map(k => ({ ...k, label: humanTimeKindLabel(k.kind, surface) }));
  // Every session without a row of its own, so the rows add up to the total.
  const rest = {
    sessions: h.sessions - kinds.reduce((n, k) => n + k.sessions, 0),
    humanMinutes: h.humanMinutes.likely - kinds.reduce((n, k) => n + k.humanMinutes, 0),
    claudeMinutes: h.claudeMinutes - kinds.reduce((n, k) => n + k.claudeMinutes, 0),
  };
  if (kinds.length > 0 && rest.sessions > 0) kinds.push({ kind: '_other_kinds', ...rest, label: 'Other kinds' });
  return (
    <Frame
      title={`By hand vs with ${tool}`}
      tag="AI estimate"
      period={`Last ${h.windowDays} days`}
      answer={<>By hand, {whose} would have taken about <b>{hours(h.humanMinutes.likely)} hours</b>, against <b>{hours(h.claudeMinutes)} hours</b> with {tool}{longer ? <>, {longer}</> : null}.</>}
      note={<>
        {plural(h.sessions, 'session', 'sessions')} with an estimate. The by-hand time is Claude&apos;s estimate for each session, added up: between {hours(h.humanMinutes.low)} and {hours(h.humanMinutes.high)} hours in all. The time with {tool} is measured active time.
        {h.check ? ` Spot-checked in ${h.check.period}: ${num(h.check.aboutRight)} of ${num(h.check.reviewed)} about right.` : ' The estimates have not been spot-checked yet.'}
        {onSeeSessions ? <> <button type="button" onClick={onSeeSessions} className={linkCls}>See the sessions</button></> : null}
      </>}
    >
      {[[`With ${tool}`, h.claudeMinutes, false] as const, ['By hand (estimate)', h.humanMinutes.likely, true] as const].map(([l, m, est]) => (
        <div key={l} className="grid grid-cols-[minmax(0,130px)_minmax(0,1fr)_64px] gap-2.5 items-center py-[3px] text-[13px]">
          <span className="text-[#333333]">{l}</span>
          <Track value={m / Math.max(h.claudeMinutes, h.humanMinutes.likely, 1)} striped={est} />
          <span className="text-right tabular-nums">{est ? '≈' : ''}{hours(m)} h</span>
        </div>
      ))}
      {kinds.length > 0 && (
        <div className="mt-3 pt-2 border-t border-[#EAEAEA]">
          <div className="text-[12px] font-semibold text-[#333333] mb-0.5">By kind of work</div>
          {kinds.map(k => (
            <div key={k.kind} className="flex items-center gap-2.5 py-1 text-[13px]">
              <span className="min-w-0 truncate text-[#333333]">{k.label}</span>
              <span className="text-[#8F8F8F] whitespace-nowrap">{plural(k.sessions, 'session', 'sessions')}</span>
              <span className="ml-auto text-[#333333] whitespace-nowrap tabular-nums">≈{hours(k.humanMinutes)} h by hand · {hours(k.claudeMinutes)} h with {tool}</span>
            </div>
          ))}
        </div>
      )}
    </Frame>
  );
}

/* ── The work behind a figure ─────────────────────────────────── */

interface TaskRow {
  sessionId?: string; at: number; tier?: number; taskType?: string; text?: string | null;
  description?: string | null; outputs?: string | null; title?: string; status?: string;
  humanMinutes?: number; claudeMinutes?: number;
  /** Whose it is, on a department's list. */
  name?: string | null;
}

export function TaskList({ kind, period, userId, who, onClose, names, vendor = 'all', dept, tool = 'Claude' }: {
  kind: DrillKind; period: PulsePeriod; userId: string | null; who: Who; onClose: () => void; names?: TierNames;
  /** A department's work instead of one person's: every member's, each row naming whose. */
  dept?: string;
  /** What the "with" side of a by-hand estimate counts, as ByHandPanel says it. */
  tool?: string;
  /** The page's All / Claude / ChatGPT view, so the list is the same sessions as the panel above it. */
  vendor?: Vendor;
}) {
  const [rows, setRows] = useState<TaskRow[] | null>(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    setRows(null);
    const qs = new URLSearchParams({ kind, period, vendor });
    if (dept) qs.set('dept', dept);
    else if (userId) qs.set('userId', userId);
    fetch(`/api/pulse/me/tasks?${qs}`)
      .then(r => (r.ok ? r.json() : { items: [], textVisible: false }))
      .then(d => { setRows(d.items ?? []); setVisible(!!d.textVisible); })
      .catch(() => setRows([]));
  }, [kind, period, userId, vendor, dept]);
  const tiers = tierList(names);
  const title = kind === 'capabilities' ? 'New ways of working'
    : kind === 'humantime' ? 'Sessions with a by-hand estimate'
      : kind === 'realwork' ? `Tasks judged ${deepWords(names)}` : 'Every task';
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
            {r.name && <span className="font-medium text-[#0A0A0A]">{r.name}</span>}
            {r.tier !== undefined && <span className="font-semibold text-[#0A0A0A]">{tiers[r.tier - 1] ?? `Tier ${r.tier}`}</span>}
            {r.taskType && <span className="text-[#666666]">{cap(r.taskType.replace(/_/g, ' '))}</span>}
            {r.title && <span className="font-semibold text-[#0A0A0A]">{r.title}</span>}
            {r.status && <span className="text-[#666666]">{r.status === 'confirmed' ? 'confirmed' : 'waiting for review'}</span>}
            {r.humanMinutes !== undefined && (
              <span className="text-[#666666]">≈ {hours(r.humanMinutes)} h by hand against {hours(r.claudeMinutes ?? 0)} h with {tool}</span>
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

export function DeeperPanel({ q, who, names }: { q: MyPeriod; who: Who; names?: TierNames }) {
  return (
    <DepthPanel
      weeks={q.weeks}
      grid={q.grid}
      end={q.end}
      names={names}
      title={`Is ${poss(who)} work getting deeper?`}
      subject={who.you ? 'you handed over' : `${who.name} handed over`}
      whose={poss(who)}
    />
  );
}

/**
 * The depth panel itself: the delegation journey grid by default, the longer views behind the
 * same switch. Shared by Work Pulse and Developer Pulse, each passing its own tier names and
 * its own word for a unit of work.
 */
export function DepthPanel({ weeks, grid, end, names, title, subject, whose, unit = 'task' }: {
  weeks: Array<{ weekStart: number; t1: number; t2: number; t3: number }>;
  grid: Array<{ weekStart: number; t1: number; t2: number; t3: number }>;
  end: number;
  names?: TierNames;
  title: string;
  /** How the grid sentence opens: "you handed over", "Finance handed over". */
  subject: string;
  /** Whose tasks the longer view is about: "your", "Finance's". */
  whose: string;
  /** What one row of the grid counts: a task on Work Pulse, a session on Developer Pulse. */
  unit?: 'task' | 'session';
}) {
  const [window, setWindow] = useState<DepthWindow>(6);
  const cols = depthColumns(weeks, window === 6 ? 13 : window, end);
  return (
    <Frame
      title={title}
      judged
      period={<DepthSwitch window={window} onWindow={setWindow} />}
      answer={window === 6 ? gridSentence(grid, subject, names, unit) : depthSentence(cols, window, whose, names, unit)}
      note={window === 6 ? `Each number is a count of ${unit}s that week. The last column is the week in progress.`
        : window === 52 ? 'One column per calendar month.' : 'One column per completed week, Monday to Sunday.'}
    >
      {window === 6 ? <><TierGrid grid={grid} names={names} /><TierLegend names={names} /></> : <DepthChart cols={cols} names={names} />}
    </Frame>
  );
}

/* ── Who is in it ─────────────────────────────────────────────── */

export interface PersonRow {
  id: string;
  display_name: string | null;
  email: string;
  deep: number;
  all: number;
  share: number | null;
  topTierThisWeek: number | null;
  lastActive: number | null;
}

export function PeoplePanel({ rows, dept, names, thenVsNow }: {
  rows: PersonRow[];
  dept: string;
  names?: TierNames;
  /** Each person's share then against now, from the delegation window. */
  thenVsNow?: Map<string, { then: number; now: number; arrow: 'up' | 'flat' | 'down' }>;
}) {
  // Users refuses viewers, so a viewer sees names without a link.
  const role = useSessionRole();
  const canOpen = role !== '' && role !== 'viewer';
  if (rows.length === 0) return (
    <Frame title={`Who is in ${dept}`}>
      <Muted>No one in {dept} has any activity yet.</Muted>
    </Frame>
  );
  const tiers = tierList(names);
  const top = rows[0];
  const quiet = rows.filter(r => r.all === 0);
  const since = (s: number | null) => {
    if (!s) return 'not seen';
    const d = Math.floor((Date.now() / 1000 - s) / 86400);
    return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
  };
  const arrow = { up: '↑', flat: '→', down: '↓' };
  // Only the top two tiers count as deep work this week.
  const deepThisWeek = rows.filter(r => (r.topTierThisWeek ?? 0) >= 2);
  const arrowInk = { up: '#1A7F37', flat: '#8F8F8F', down: '#B54708' };
  return (
    <Frame
      title={`Who is in ${dept}`}
      judged
      period={plural(rows.length, 'person', 'people')}
      answer={<>
        {top.share !== null ? <><b>{top.display_name ?? top.email}</b> has the highest share of {deepWords(names)} work: {Math.round(top.share * 100)}% of their tasks.</> : <>Nobody has classified work in this period.</>}
        {quiet.length > 0 ? <> {quiet.length === 1 ? `${quiet[0].display_name ?? quiet[0].email} has` : `${num(quiet.length)} people have`} handed over nothing.</> : null}
      </>}
      note={`${canOpen ? "Click a name to open that person's page. " : ''}Sorted by how much of their work reached the top two tiers.`}
    >
      {/* Scrolls sideways inside the card on a phone rather than pushing the page wider. */}
      <div className="overflow-x-auto"><div className="min-w-[440px]">
      <div className="grid grid-cols-[minmax(0,1fr)_86px_minmax(0,120px)_52px_92px_80px] gap-2.5 text-[11px] text-[#8F8F8F] pb-1">
        <span>Person</span><span className="text-right">{DeepWords(names)}</span><span /><span className="text-right">Share</span><span>Then and now</span><span className="text-right">Last active</span>
      </div>
      {rows.map(r => {
        // Someone with no work in the period shows no trend.
        const t = r.all > 0 ? thenVsNow?.get(r.id) : undefined;
        return (
          <div key={r.id} className="grid grid-cols-[minmax(0,1fr)_86px_minmax(0,120px)_52px_92px_80px] gap-2.5 items-center py-[3px] text-[13px] border-b border-[#F7F7F7] last:border-b-0">
            {canOpen
              ? <Link href={`/pulse/users?userId=${encodeURIComponent(r.id)}`} className="truncate text-[#0A0A0A] hover:text-[#1F6F8B]">{r.display_name ?? r.email}</Link>
              : <span className="truncate text-[#0A0A0A]">{r.display_name ?? r.email}</span>}
            <span className="text-right tabular-nums text-[#333333]">{r.all > 0 ? `${num(r.deep)} of ${num(r.all)}` : 'not judged'}</span>
            <span>{r.share !== null && <Track value={r.share} />}</span>
            <span className="text-right tabular-nums">{r.share !== null ? `${Math.round(r.share * 100)}%` : ''}</span>
            <span className="text-[12px] whitespace-nowrap" style={{ color: t ? arrowInk[t.arrow] : '#B3B3B3' }}>
              {t ? `${Math.round(t.then * 100)}% ${arrow[t.arrow]} ${Math.round(t.now * 100)}%` : r.all > 0 ? 'not enough weeks' : ''}
            </span>
            <span className="text-right text-[12px] text-[#8F8F8F] whitespace-nowrap">{since(r.lastActive)}</span>
          </div>
        );
      })}
      </div></div>
      <p className="m-0 mt-2 text-[12px] text-[#8F8F8F]">
        {DeepWords(names)} work this week: {deepThisWeek.length === 0 ? 'nobody yet' : deepThisWeek.map(r => `${r.display_name ?? r.email} (${tiers[(r.topTierThisWeek ?? 2) - 1]})`).join(', ')}.
      </p>
    </Frame>
  );
}

/* ── 4: What was produced ─────────────────────────────────────── */

export function ProducedPanel({ q, who, period, uploads }: {
  q: MyPeriod; who: Who; period: PulsePeriod;
  /** Documents brought in, for a department: sessions with an upload, and how many files. */
  uploads?: { sessions: number; files: number } | null;
}) {
  const p = q.produced;
  const max = Math.max(1, ...p.byKind.map(k => k.files));
  // Named kinds largest first, files of no named kind last, whatever their number.
  const named = p.byKind.filter(k => k.kind !== 'Other').sort((a, b) => b.files - a.files);
  const other = p.byKind.filter(k => k.kind === 'Other');
  const rows = [...named, ...other.map(k => ({ ...k, kind: 'Other files' }))];
  // The second kind is named only when it is at least half the size of the first, and "mostly"
  // is said only when the kinds named make up more than half of all the files.
  const topKinds = named.slice(0, 2).filter((k, i) => i === 0 || k.files * 2 >= named[0].files);
  const top = topKinds.reduce((n, k) => n + k.files, 0) * 2 > p.files ? topKinds.map(k => k.kind.toLowerCase()) : [];
  return (
    <Frame
      title={who.you ? 'What you produced' : 'What they produced'}
      period={PERIOD_SHAPE[period].label}
      answer={p.files === 0
        ? <>No files saved, sent or published, from <b>{plural(p.sessions, 'session', 'sessions')}</b>.</>
        : <><b>{plural(p.files, 'file', 'files')}</b> from {plural(p.sessions, 'session', 'sessions')}{top.length ? <>, mostly {top.join(' and ')}</> : null}.</>}
      note={<>A session produced a file when Claude saved, sent or published one, in Claude Chat when a reply made an artifact or a file, and in ChatGPT when a reply listed a file.{uploads && uploads.sessions > 0 ? ` ${num(uploads.sessions)} ${uploads.sessions === 1 ? 'session had' : 'sessions had'} documents brought in, ${plural(uploads.files, 'file', 'files')} in all.` : ''}</>}
    >
      {rows.map(k => (
        <div key={k.kind} className="grid grid-cols-[minmax(0,120px)_minmax(0,1fr)_36px] gap-2.5 items-center py-[3px] text-[13px]">
          <span className="truncate text-[#333333]">{k.kind}</span>
          <Track value={k.files / max} />
          <span className="text-right tabular-nums">{num(k.files)}</span>
        </div>
      ))}
    </Frame>
  );
}

/* ── 5: Skills and connectors colleagues use ──────────────────── */

export function ColleagueToolsPanel({ q, who, department, period, team = false }: {
  q: MyPeriod; who: Who; department: string | null; period: PulsePeriod;
  /** A department's own page: the colleagues counted are the people in other teams. */
  team?: boolean;
}) {
  const t = q.colleagueTools;
  const skills = t.filter(x => x.type === 'skill').length, conns = t.length - skills;
  const parts = [skills ? plural(skills, 'skill', 'skills') : null, conns ? plural(conns, 'connector', 'connectors') : null].filter(Boolean).join(' and ');
  // A person is compared with their own department; a department with the people in other teams.
  const where = team ? 'in other teams' : department ? `in ${department}` : 'across the organisation';
  return (
    <Frame
      title={team ? 'Skills and connectors other teams use' : 'Skills and connectors colleagues use'}
      period={PERIOD_SHAPE[period].label}
      answer={t.length === 0
        ? <>{who.you ? 'You use' : `${who.name} uses`} every skill and connector two or more colleagues {where} use.</>
        : <>Colleagues {where} use <b>{parts}</b> {who.you ? "you haven't" : "they haven't"} tried.</>}
      note={q.ownTools.length > 0 ? <>{who.you ? 'Your own' : 'Their own'}: {q.ownTools.map(n => (n === 'custom_skill' || n.includes(':') ? skillLabel(n) : connectorLabel(n))).join(', ')}.</> : undefined}
    >
      {t.map(x => (
        <div key={`${x.type}:${x.name}`} className="flex items-center gap-2.5 py-1.5 border-b border-[#F2F2F2] last:border-b-0 text-[13px]">
          <span className="min-w-0 truncate text-[#0A0A0A]">{x.type === 'skill' ? skillLabel(x.name) : connectorLabel(x.name)}</span>
          <span className="text-[#777777] whitespace-nowrap">{x.type} · {num(x.people)} {team ? (x.people === 1 ? 'person in other teams' : 'people in other teams') : (x.people === 1 ? 'colleague' : 'colleagues')}</span>
          {x.libraryId !== null && <Link href={`/library/${x.libraryId}`} className={`${linkCls} ml-auto`}>See it</Link>}
        </div>
      ))}
    </Frame>
  );
}

/* ── New ways of working, named ───────────────────────────────── */

export interface CapabilityItem {
  sessionId: string;
  displayName: string;
  taskType: string;
  occurredAt: number;
  description: string | null;
  detailWithheld: boolean;
  capability?: { eventId: number; status: 'candidate' | 'confirmed' };
}

/** One row per session: two flags on the same session read as one, confirmed if either is. */
function onePerSession(list: CapabilityItem[]): CapabilityItem[] {
  const by = new Map<string, CapabilityItem>();
  for (const i of list) {
    const had = by.get(i.sessionId);
    if (!had || (had.capability?.status !== 'confirmed' && i.capability?.status === 'confirmed')) by.set(i.sessionId, i);
  }
  return [...by.values()].sort((a, b) => b.occurredAt - a.occurredAt);
}

export function CapabilitiesPanel({ items, all, pending, canReview, onChanged }: {
  /** The newest few, shown as rows. */
  items: CapabilityItem[];
  /** Every one from work in the last 30 days, when the page has them (a department), for the count. */
  all?: CapabilityItem[];
  pending: number;
  canReview: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const act = async (eventId: number, action: 'confirm' | 'dismiss') => {
    setBusy(eventId);
    await fetch('/api/pulse/capabilities', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: eventId, action }),
    }).catch(() => {});
    setBusy(null);
    onChanged();
  };
  const shown = onePerSession(items);
  const counted = onePerSession(all && all.length > 0 ? all : items);
  const confirmed = counted.filter(i => i.capability?.status === 'confirmed').length;
  return (
    <Frame
      title="New ways of working"
      judged
      period="From work in the last 30 days"
      answer={counted.length === 0
        ? <>Nothing new from work in the last 30 days.{pending > 0 ? <> <b>{num(pending)}</b> {pending === 1 ? 'is' : 'are'} waiting for review.</> : null}</>
        : <><b>{num(confirmed)} confirmed</b> from work in the last 30 days{pending > 0 ? <>, and <b>{num(pending)}</b> {pending === 1 ? 'is' : 'are'} waiting for review</> : null}.</>}
      note={NEW_WAYS_OF_WORKING}
    >
      {shown.map(i => (
        <div key={i.sessionId} className="py-2 border-b border-[#F2F2F2] last:border-b-0 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="m-0 flex items-baseline gap-2 flex-wrap text-[13px]">
              <span className="font-semibold text-[#0A0A0A]">{i.displayName}</span>
              <span className="text-[#666666]">{cap(i.taskType.replace(/_/g, ' '))}</span>
              <span className="text-[#8F8F8F]">{dateOf(i.occurredAt)}</span>
              {i.capability?.status === 'candidate' && <span className="text-[12px] text-[#B54708]">waiting for review</span>}
            </p>
            {i.description && <p className="m-0 mt-0.5 text-[13px] leading-5 text-[#444444] line-clamp-2">{i.description}</p>}
          </div>
          {canReview && i.capability?.status === 'candidate' && (
            <span className="flex gap-1.5 shrink-0">
              <button type="button" disabled={busy === i.capability.eventId} onClick={() => act(i.capability!.eventId, 'confirm')} className={`${B.secondary} !py-0.5 !px-2 !text-[12px]`}>Confirm</button>
              <button type="button" disabled={busy === i.capability.eventId} onClick={() => act(i.capability!.eventId, 'dismiss')} className={`${B.secondary} !py-0.5 !px-2 !text-[12px]`}>Dismiss</button>
            </span>
          )}
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

/**
 * The period panels when there is nothing to put in them: no work recorded yet, or it
 * failed to load. Each keeps its place on the page and says which.
 */
export function EmptyPeriodPanels({ who, failed, team = false }: { who: Who; failed: boolean; team?: boolean }) {
  const msg = failed ? LOAD_FAILED : `Nothing has been recorded for ${who.you ? 'you' : who.name} yet.`;
  const titles = [
    who.you ? 'Your work' : `${who.name}'s work`,
    `Is ${poss(who)} work getting deeper?`,
    who.you ? 'What you produced' : 'What they produced',
    team ? 'Skills and connectors other teams use' : 'Skills and connectors colleagues use',
  ];
  return <>{titles.map(t => <Frame key={t} title={t}><Muted>{msg}</Muted></Frame>)}</>;
}

/** The spend panel when its figures failed to load. */
export function SpendFailed({ who }: { who: Who }) {
  return <Frame title={who.you ? 'Your spend' : 'Their spend'}><Muted>{LOAD_FAILED}</Muted></Frame>;
}
