// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { gapPct, routeRank, usdWhole } from '@/lib/finance/spend-review-format';
import { MonthPicker, monthOptions, money, pct, ukDate, LimitsNotice, LimitBar, UpdatedLine, type LimitsStatus } from '@/components/spend-review/shared';
import { PageBody, Toolbar, Panel, PanelFoot, Strip, Figure, T, B, Tag, Chip, Notice, Muted, Segmented, cx } from '@/components/precision/ui';
import { SURFACE_COLOR, PRODUCT_COLOR } from '@/lib/ui/chart-colours';
import { surfaceName, type SpendReviewSurface } from '@/lib/finance/spend-review-format';
import { useOpenAiOnly, useConnectedProducts } from '@/components/shared/VendorSwitch';
import { formatModelLabel } from '@/lib/pulse/code/model-label';
import { useAskPageNote } from '@/components/ask/useAskAvailable';
import { prettyModel } from '@/components/finance/ModelEfficiencySection';
import type { SpendReviewTopRoute, EfficiencyReach } from '@/lib/finance/spend-review';
import { topTierName } from '@/lib/pulse/tier-names';
import { sortLabels } from '@/lib/ui/alphabetical';

type Surface = SpendReviewSurface;
interface LimitRow { period: string; limit: number | null; spend: number; currency: string; source: string; shareUsed: number | null }
interface Person {
  userId: string | null;
  displayName: string;
  email: string | null;
  department: string | null;
  codeUsd: number;
  coworkUsd: number;
  /** Present when OpenAI's Compliance API is connected. */
  chatgptUsd?: number;
  codexUsd?: number;
  totalUsd: number;
  priorTotalUsd: number | null;
  unpricedOnly: boolean;
  mainWork: { label: string; surface: Surface; share: number } | null;
  routeCount: number;
  /** Sessions started by a script or test harness this month. */
  automatedRuns?: number;
  /** Their largest-saving route; null (or absent) with no route. */
  topRoute?: SpendReviewTopRoute | null;
  anthropic: LimitRow | null;
  pendingRequestAt: string | null;
}
interface Summary {
  totalUsd: number;
  priorTotalUsd: number | null;
  /** Claude / OpenAI split of totalUsd, present with ChatGPT and Codex connected and shown. */
  vendors?: { claudeUsd: number; openaiUsd: number };
  /** Last month's split (all Claude when last month had none); null when last month had no spend. */
  priorVendors?: { claudeUsd: number; openaiUsd: number } | null;
  people: number;
  halfSpendPeople: number | null;
  topWork: { label: string; surface: Surface; share: number }[];
  peopleWithRoutes: number;
  orgRereadShare: number | null;
  /** How far people got towards each board this month; absent from older cached indexes. */
  efficiencyReach?: { claude: EfficiencyReach; openai: EfficiencyReach | null };
}
interface EfficiencyEntry { userId: string; displayName: string; department: string | null; vsColleagues: number; sessions: number; deepRate: number | null; peerDeepRate: number | null }
type BoardVendor = 'claude' | 'openai';
interface Board { vendor: BoardVendor; rows: EfficiencyEntry[]; boardPeriod: string; reach: EfficiencyReach | null }
const BOARD_VENDOR_LABEL: Record<BoardVendor, string> = { claude: 'Claude', openai: 'ChatGPT and Codex' };

const peopleCount = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;

/** Why a board has no one on it, in one sentence, from the figures the index counted. */
function emptyBoardReason(vendor: BoardVendor, r: EfficiencyReach | null, top: string): string {
  const work = `${BOARD_VENDOR_LABEL[vendor]} work`;
  if (!r) return `Nobody ranked on ${work} yet: it needs at least 10 sessions with colleagues doing the same kinds of work.`;
  if (r.compared === 0) return `Nobody ranked on ${work}: no one had sessions of a kind of work that enough colleagues also do.`;
  if (r.enough === 0) return `Nobody ranked on ${work}: ${peopleCount(r.compared)} had sessions to compare with colleagues, but the most anyone had was ${r.mostSessions} and the board needs ${r.minSessions}.`;
  if (r.cheaper === 0) return `Nobody ranked on ${work}: ${peopleCount(r.enough)} had ${r.minSessions} or more sessions to compare, but none cost less than colleagues.`;
  return `Nobody ranked on ${work}: ${peopleCount(r.cheaper)} cost less than colleagues, but none had a ${top} share measured within 10 points of theirs.`;
}

const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function monthLabel(p: string): string {
  const [y, m] = p.split('-').map(Number);
  return `${MONTH_LONG[m - 1]} ${y}`;
}

/**
 * "Most efficient this month", one board per vendor: Claude's work (Code and
 * Cowork) and OpenAI's (ChatGPT and Codex) are scored apart, never mixed. Two
 * boards show as tabs; one shows on its own.
 */
function EfficiencyBoard({ boards, period, top }: { boards: Board[]; period: string; top: string }) {
  const [picked, setPicked] = useState<BoardVendor | null>(null);
  if (boards.length === 0) return null;
  const tabs = boards.length > 1;
  // Open on the first board with anyone on it, unless a tab was picked.
  const board = boards.find(b => b.vendor === picked) ?? boards.find(b => b.rows.length > 0) ?? boards[0];
  const { rows, boardPeriod } = board;
  const vendorWork = tabs ? ` of ${BOARD_VENDOR_LABEL[board.vendor]} work` : '';
  const earlier = boardPeriod !== period;
  return (
    <Panel
      title={earlier || period !== monthOptions()[0].value ? `Most efficient in ${monthLabel(boardPeriod)}` : 'Most efficient this month'}
      subtitle="Lower cost than colleagues for the same kinds of work, with work as deep as theirs · at least 10 sessions"
      right={tabs ? (
        <Segmented
          label="Most efficient on"
          options={boards.map(b => ({ value: b.vendor, label: BOARD_VENDOR_LABEL[b.vendor] }))}
          value={board.vendor}
          onChange={setPicked}
        />
      ) : undefined}
      flush
    >
      {earlier && (
        <div className="px-4 pt-3">
          <Notice tone="info">
            Showing {monthLabel(boardPeriod)}: nobody has 10 sessions{vendorWork} in {monthLabel(period)} yet, which the comparison needs to be fair. The board switches to {monthLabel(period)} once enough work is in, usually within the first week.
          </Notice>
        </div>
      )}
      {rows.length === 0 ? (
        <div className="p-6 text-center"><Muted>{emptyBoardReason(board.vendor, board.reach, top)}</Muted></div>
      ) : (
        <div className="overflow-x-auto">
          <table className={cx(T.table, earlier && 'mt-2')}>
            <thead>
              <tr className={T.headRow}>
                <th scope="col" className={T.th}><span className="sr-only">Rank</span></th>
                <th scope="col" className={T.th}>Person</th>
                <th scope="col" className={T.thRight}>Sessions</th>
                <th scope="col" className={T.thRight}>vs colleagues</th>
                <th scope="col" className={T.thRight}>{top} share</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const below = 1 - r.vsColleagues;
                return (
                  <tr key={r.userId} className={T.row}>
                    <td className={cx(T.td, 'w-8 text-[12px] text-[#B3B3B3] tabular-nums')}>{i + 1}</td>
                    <td className={T.td}>
                      <Link href={`/finops/spend-review/${encodeURIComponent(r.userId)}?period=${encodeURIComponent(boardPeriod)}`} className="font-medium text-[#0A0A0A] hover:text-[#1F6F8B] hover:underline">{r.displayName}</Link>
                      <span className="block text-[13px] text-[#8F8F8F]">{r.department ?? 'No department'}</span>
                    </td>
                    <td className={cx(T.tdRight, 'text-[#666666]')}>{r.sessions}</td>
                    <td className={cx(T.tdRight, 'font-medium', below > 0 ? 'text-[#1A7F37]' : 'text-[#666666]')}>
                      {gapPct(r.vsColleagues)} {below > 0 ? 'below' : 'above'} colleagues
                    </td>
                    <td className={cx(T.tdRight, 'text-[13px] text-[#666666]')}>
                      {r.deepRate !== null && r.peerDeepRate !== null ? <>{pct(r.deepRate)} vs {pct(r.peerDeepRate)}</> : 'Not measured'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <PanelFoot>
        Each of a person&apos;s sessions is set against colleagues&apos; typical session cost for the same kind of work, and the middle of those comparisons is their figure. Only people whose share of {top} work is no more than 10 points below colleagues&apos; are ranked, so cheaper-because-shallower work doesn&apos;t count as efficient.
        {tabs && ' Claude work and ChatGPT and Codex work are ranked on separate boards: each board scores people on that work only (Claude Code and Cowork, or ChatGPT and Codex).'}
      </PanelFoot>
    </Panel>
  );
}

interface IndexData {
  period: string;
  isCurrentMonth: boolean;
  /** ChatGPT and Codex spend is included (OpenAI's Compliance API is connected). */
  openai?: boolean;
  /** The board on Claude's work (Claude Code and Cowork). */
  efficiency?: EfficiencyEntry[];
  /** The month the efficiency board covers: last month while this month is too new. */
  efficiencyPeriod?: string;
  /** The board on OpenAI's work (ChatGPT and Codex), and its month. */
  efficiencyOpenai?: EfficiencyEntry[];
  efficiencyOpenaiPeriod?: string;
  updatedAt?: number;
  people: Person[];
  summary: Summary;
  unpricedModels: string[];
  limits: { status: LimitsStatus; fetchedAt: number | null; pendingCount: number };
  nearLimitShare: number;
  /** What this customer calls the top tier, for the efficiency board. */
  topTier?: string;
}

/** Below this much spend last month, the change reads New rather than a percentage. */
const MIN_PRIOR_FOR_CHANGE = 1;

function reviewHref(p: Person, period: string): string | null {
  return p.userId ? `/finops/spend-review/${encodeURIComponent(p.userId)}?period=${encodeURIComponent(period)}` : null;
}

/** Share of the current UTC month gone by, so last month can be compared at the same pace. */
function monthElapsed(period: string): number {
  const [y, m] = period.split('-').map(Number);
  const start = Date.UTC(y, m - 1, 1);
  const end = Date.UTC(y, m, 1);
  return Math.min(1, Math.max(0.01, (Date.now() - start) / (end - start)));
}

/** "▲ 40%" against last month (at the same pace for the current month); "New" when there was nothing last month. */
function Change({ now, prior, pace }: { now: number; prior: number | null; pace: number }) {
  if (prior !== null) prior = prior * pace;
  // Under $1 last month a percentage means nothing (cents to dollars reads as +50,000%).
  if (prior === null || prior < MIN_PRIOR_FOR_CHANGE) return now > 0 ? <span className="text-[13px] text-[#666666]">New</span> : <span className="text-[13px] text-[#B3B3B3]">Not measured</span>;
  const delta = (now - prior) / prior;
  if (now / prior >= 3) return <span className="text-[13px] tabular-nums text-[#0A0A0A] font-medium">▲ ×{(now / prior).toFixed(now / prior >= 10 ? 0 : 1)}</span>;
  if (Math.abs(delta) < 0.005) return <span className="text-[13px] text-[#666666]">Flat</span>;
  const up = delta > 0;
  return (
    <span className={cx('text-[13px] tabular-nums', up ? 'text-[#0A0A0A] font-medium' : 'text-[#666666]')}>
      {up ? '▲' : '▼'} {pct(Math.abs(delta))}
    </span>
  );
}

function SplitBar({ p, openai }: { p: Person; openai: boolean }) {
  // Each product's spend, in the shared product colours.
  const parts = [
    { label: surfaceName('cowork', openai), usd: p.coworkUsd, colour: SURFACE_COLOR.cowork },
    { label: surfaceName('code', openai), usd: p.codeUsd, colour: SURFACE_COLOR.code },
    ...(openai ? [
      { label: 'ChatGPT', usd: p.chatgptUsd ?? 0, colour: PRODUCT_COLOR.chatgpt_chat },
      { label: 'Codex', usd: p.codexUsd ?? 0, colour: PRODUCT_COLOR.codex },
    ] : []),
  ];
  const total = parts.reduce((a, x) => a + x.usd, 0);
  if (total <= 0) return null;
  return (
    <div className="flex h-1 w-[72px] rounded-full overflow-hidden gap-px bg-[#F2F2F2] ml-auto mt-1" title={parts.filter(x => x.usd > 0).map(x => `${x.label} ${money(x.usd)}`).join(' · ')}>
      {parts.map(x => <div key={x.label} style={{ width: `${(x.usd / total) * 100}%`, background: x.colour }} />)}
    </div>
  );
}

type SortKey = 'name' | 'work' | 'spend' | 'change' | 'routes' | 'limit';

/** Column heading that sorts the table; a second click reverses the order. */
function SortHeader({ label, k, sort, onSort, align = 'left' }: {
  label: string; k: SortKey; sort: { key: SortKey; desc: boolean }; onSort: (k: SortKey) => void; align?: 'left' | 'right';
}) {
  const active = sort.key === k;
  return (
    <th scope="col" className={align === 'right' ? T.thRight : T.th} aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button type="button" onClick={() => onSort(k)} className={cx('inline-flex items-center gap-1 font-medium hover:text-[#0A0A0A]', active && 'text-[#0A0A0A]')}>
        {label}
        <span className="text-[11px]" aria-hidden="true">{active ? (sort.desc ? '↓' : '↑') : '↕'}</span>
      </button>
    </th>
  );
}

/** A section folded away by default: a header row that opens it. */
function Fold({ title, sub, children, open: openProp, onOpenChange }: {
  title: string; sub?: ReactNode; children: ReactNode;
  /** Controlled from outside, when another control opens it. */
  open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (f: (o: boolean) => boolean) => { const next = f(open); setOpenState(next); onOpenChange?.(next); };
  return (
    <section className="flex flex-col gap-3 min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-x-3 gap-y-1 flex-wrap w-full text-left bg-white border border-[#EAEAEA] rounded-[14px] px-4 py-3 hover:bg-[#FAFAFA]"
      >
        <span aria-hidden="true" className={cx('text-[11px] text-[#8F8F8F] transition-transform', open && 'rotate-90')}>▶</span>
        <span className="text-[14px] font-semibold text-[#0A0A0A] leading-5">{title}</span>
        {sub && <span className="text-[13px] text-[#8F8F8F]">{sub}</span>}
        <span className="ml-auto text-[13px] font-medium text-[#1F6F8B]">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && children}
    </section>
  );
}

/** A route in full words, with the model it moves away from where there is one. */
function routeWords(r: SpendReviewTopRoute): { text: string; from: string | null } {
  switch (r.kind) {
    case 'tool': return { text: `Use the ${r.name} ${r.toolType}`, from: null };
    case 'context': return { text: 'Long conversations', from: null };
    case 'scheduled': return { text: `Try ${r.cheaperFamilies.join(' or ')}`, from: r.fromModel };
    case 'model':
      return {
        text: r.direction === 'save' ? `Save with ${prettyModel(r.toModel)}`
          : r.direction === 'trial' ? `Worth a trial: ${prettyModel(r.toModel)}`
          : `Worth trying ${prettyModel(r.toModel)}`,
        from: r.fromModel,
      };
  }
}

/** Rows shown before "Show all". */
const ROUTES_SHOWN = 10;

/** One row per person with a better route: proven saves first, then untested trials, each largest saving first; routes with no saving after. */
function BetterRoutes({ people, period, openai }: { people: Person[]; period: string; openai: boolean }) {
  const [all, setAll] = useState(false);
  const rows = people
    .filter((p): p is Person & { topRoute: SpendReviewTopRoute } => !!p.topRoute)
    .sort((a, b) => routeRank(a.topRoute) - routeRank(b.topRoute) || (b.topRoute.estSavingUsd ?? -1) - (a.topRoute.estSavingUsd ?? -1) || b.totalUsd - a.totalUsd);
  const shown = all ? rows : rows.slice(0, ROUTES_SHOWN);
  return (
    <Panel
      title="Better routes, proven savings first"
      badge={<Tag tone="judged">Estimate</Tag>}
      right={rows.length > 0 && <span className="text-[13px] text-[#8F8F8F] tabular-nums">{rows.length} {rows.length === 1 ? 'person' : 'people'}</span>}
      flush
    >
      {rows.length === 0 ? (
        <div className="p-6 text-center"><Muted>No route colleagues&apos; work points to yet.</Muted></div>
      ) : (
        <div className="overflow-x-auto">
          <table className={T.table}>
            <thead>
              <tr className={T.headRow}>
                <th scope="col" className={T.th}>Person</th>
                <th scope="col" className={T.th}>Work</th>
                <th scope="col" className={T.th}>Route</th>
                <th scope="col" className={T.thRight}>Saving</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(p => {
                const r = p.topRoute;
                const words = routeWords(r);
                const href = reviewHref(p, period);
                return (
                  <tr key={p.userId ?? p.email ?? p.displayName} className={cx(T.row, 'relative align-top')}>
                    <td className={T.td}>
                      {href
                        ? <Link href={href} className="block font-medium text-[#0A0A0A] hover:text-[#1F6F8B] hover:underline after:absolute after:inset-0">{p.displayName}</Link>
                        : <span className="block font-medium text-[#0A0A0A]">{p.displayName}</span>}
                      <span className="block text-[12px] text-[#8F8F8F]">{p.department ?? 'No department'}</span>
                    </td>
                    <td className={T.td}>
                      <span className="block text-[#0A0A0A]">{r.kind === 'scheduled' ? `Scheduled task: ${r.workLabel}` : r.workLabel}</span>
                      <span className="block text-[12px] text-[#8F8F8F] tabular-nums">{pct(r.workShare)} of their spend · {surfaceName(r.surface, openai)}</span>
                    </td>
                    <td className={T.td}>
                      <span className="block text-[#0A0A0A]">{words.text}</span>
                      {words.from && <span className="block text-[12px] text-[#8F8F8F]">instead of {prettyModel(words.from)}</span>}
                    </td>
                    <td className={T.tdRight}>
                      {r.estSavingUsd !== null
                        ? <span className="text-[#0A0A0A]">≈ {usdWhole(r.estSavingUsd)}</span>
                        : <span className="text-[12px] text-[#8F8F8F]">No saving estimate</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > ROUTES_SHOWN && (
        <div className="px-4 py-2.5 border-t border-[#F2F2F2]">
          <button type="button" onClick={() => setAll(v => !v)} className={B.link}>
            {all ? 'Show the first 10' : `Show all ${rows.length} people`}
          </button>
        </div>
      )}
      <PanelFoot>
        Savings are estimates: this month&apos;s sessions repriced at list price.
      </PanelFoot>
    </Panel>
  );
}

function SpendReviewIndex() {
  const search = useSearchParams();
  const [period, setPeriod] = useState(() => search.get('period') || monthOptions()[0].value);
  useAskPageNote('spend-review', `Spend Review shows the calendar month ${period}.`);
  const [data, setData] = useState<IndexData | null>(null);
  // Only OpenAI connected: no Anthropic limits and no Claude in the key or notes.
  const openaiOnly = useOpenAiOnly();
  // ChatGPT and Codex connected and shown (false while hidden on the OpenAI panel).
  const openaiConnected = useConnectedProducts()?.openai ?? false;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [onlyRoutes, setOnlyRoutes] = useState(false);
  const [onlyNear, setOnlyNear] = useState(false);
  // The Everyone table is folded; the limits figure opens it with its filter on.
  const [everyoneOpen, setEveryoneOpen] = useState(false);
  const [dept, setDept] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!refreshKey) setLoading(true);
    setError(null);
    fetch(`/api/finance/spend-review?period=${period}${refreshKey ? '&refresh=1' : ''}`)
      .then(async r => {
        if (r.status === 403) throw new Error('Spend Review is for admins and managers.');
        if (r.status === 404) throw new Error('Spend Review is part of FinOps, which is switched off on this hub.');
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Couldn't load this page. Try again.");
        return r.json();
      })
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => { setLoading(false); setRefreshing(false); });
  }, [period, refreshKey]);

  const limitsOn = data?.limits.status === 'ok' && data.isCurrentMonth && !openaiOnly;
  const nearShare = data?.nearLimitShare ?? 0.8;
  const departments = useMemo(() => sortLabels([...new Set((data?.people ?? []).map(p => p.department).filter((d): d is string => !!d))]), [data]);

  const pace = data?.isCurrentMonth ? monthElapsed(data.period) : 1;
  const defaultSort = useMemo<{ key: SortKey; desc: boolean }>(() => ({ key: limitsOn ? 'limit' : 'spend', desc: true }), [limitsOn]);

  const people = useMemo(() => {
    if (!data) return [];
    let rows = [...data.people];
    if (onlyRoutes) rows = rows.filter(p => p.routeCount > 0);
    if (onlyNear) rows = rows.filter(p => (p.anthropic?.shareUsed ?? 0) >= nearShare || p.pendingRequestAt);
    if (dept) rows = rows.filter(p => p.department === dept);
    const s = sort ?? defaultSort;
    const dir = s.desc ? -1 : 1;
    const value = (p: Person): string | number => {
      switch (s.key) {
        case 'name': return p.displayName.toLowerCase();
        case 'work': return p.mainWork?.label.toLowerCase() ?? '\uffff';
        case 'spend': return p.totalUsd;
        case 'change': return p.priorTotalUsd && p.priorTotalUsd >= MIN_PRIOR_FOR_CHANGE ? p.totalUsd / (p.priorTotalUsd * pace) : -1;
        case 'routes': return p.routeCount;
        case 'limit': return p.anthropic?.shareUsed ?? -1;
      }
    };
    rows.sort((a, b) => {
      const x = value(a), y = value(b);
      const c = typeof x === 'string' ? x.localeCompare(y as string) : (x as number) - (y as number);
      return c * dir || b.totalUsd - a.totalUsd;
    });
    return rows;
  }, [data, onlyRoutes, onlyNear, dept, nearShare, sort, defaultSort, pace]);

  function onSort(k: SortKey) {
    const current = sort ?? defaultSort;
    // Names and kinds of work start A to Z; numbers start highest first.
    setSort(current.key === k ? { key: k, desc: !current.desc } : { key: k, desc: !(k === 'name' || k === 'work') });
  }

  const pending = (data?.people ?? []).filter(p => p.pendingRequestAt);
  const near = limitsOn ? (data?.people ?? []).filter(p => (p.anthropic?.shareUsed ?? 0) >= nearShare && (p.anthropic?.shareUsed ?? 0) < 1).length : 0;
  const over = limitsOn ? (data?.people ?? []).filter(p => (p.anthropic?.shareUsed ?? 0) >= 1).length : 0;
  const s = data?.summary;
  // Claude's board unless only OpenAI is connected; OpenAI's when it is connected and shown.
  // An empty board is always this month's (the route only swaps in last month's when it has people), so this month's reach explains it.
  const reach = data?.summary.efficiencyReach;
  const boards: Board[] = data ? [
    ...(!openaiOnly ? [{ vendor: 'claude' as const, rows: data.efficiency ?? [], boardPeriod: data.efficiencyPeriod ?? period, reach: reach?.claude ?? null }] : []),
    ...(openaiOnly || openaiConnected || data.openai ? [{ vendor: 'openai' as const, rows: data.efficiencyOpenai ?? [], boardPeriod: data.efficiencyOpenaiPeriod ?? period, reach: reach?.openai ?? null }] : []),
  ] : [];
  // Spend so far split by vendor only with both vendors' spend this month, and Claude shown.
  const vendorSplit = data?.openai && !openaiOnly && s?.vendors && s.vendors.claudeUsd > 0 && s.vendors.openaiUsd > 0 ? s.vendors : null;
  const requestsPanel = pending.length > 0 ? (
        <Panel title="Requests for more usage" badge={<Tag tone="warn">{pending.length}</Tag>} flush>
          <div>
            {pending.map(p => {
              const href = reviewHref(p, period);
              return (
                <div key={(p.userId ?? p.email) + 'req'} className="flex items-center justify-between px-4 py-2.5 gap-4 border-t border-[#F2F2F2] first:border-t-0">
                  <div className="min-w-0">
                    <p className="m-0 text-[14px] font-medium text-[#0A0A0A] truncate">{p.displayName}</p>
                    <p className="m-0 text-[13px] text-[#666666] tabular-nums">
                      Asked on {ukDate(p.pendingRequestAt)}
                      {p.anthropic && <> · {money(p.anthropic.spend, p.anthropic.currency)} of {p.anthropic.limit === null ? 'no limit' : money(p.anthropic.limit, p.anthropic.currency)} used</>}
                      {p.mainWork && <> · mostly {p.mainWork.label.toLowerCase()}</>}
                      {p.routeCount > 0 && <> · {p.routeCount} better route{p.routeCount === 1 ? '' : 's'}</>}
                    </p>
                  </div>
                  {href
                    ? <Link href={href} className={cx(B.link, 'shrink-0')}>Review spend</Link>
                    : <span className="text-[13px] text-[#8F8F8F] shrink-0">No Command Centre activity to review</span>}
                </div>
              );
            })}
          </div>
          <PanelFoot>Approve or deny the request in claude.ai Organisation settings.</PanelFoot>
        </Panel>
  ) : limitsOn ? (
        <Panel title="Requests for more usage"><Muted>No requests for more usage.</Muted></Panel>
  ) : null;
  const rereadNotice = s && s.orgRereadShare !== null && s.orgRereadShare >= 0.3 ? (
        <Notice tone="info" title={`${pct(s.orgRereadShare)} of the month's ${data?.openai ? 'Claude ' : ''}spend is Claude re-reading earlier conversation on every message.`}>
          That is normal for long Cowork sessions; a person is only flagged when they re-read clearly more than colleagues doing the same work.
        </Notice>
  ) : null;

  const peoplePanel = data && s ? (
    <Panel
      title="People"
      right={data.people.length > 0 && (
        <>
          <Chip on={onlyRoutes} onClick={() => setOnlyRoutes(v => !v)}>Has a better route</Chip>
          {limitsOn && (
            <Chip on={onlyNear} onClick={() => setOnlyNear(v => !v)}>Close to limit or asked for more</Chip>
          )}
          {departments.length > 1 && (
            <select value={dept} onChange={e => setDept(e.target.value)} className={B.select} aria-label="Department">
              <option value="">All departments</option>
              {departments.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          )}
          <span className="text-[13px] text-[#8F8F8F] tabular-nums">{people.length} of {data.people.length}</span>
        </>
      )}
      flush
    >
      {data.people.length === 0 ? (
        <div className="px-6 py-8 text-center flex flex-col items-center gap-1.5">
          <span className="text-[14px] font-medium text-[#0A0A0A]">No measured spend for this month yet.</span>
          {data.isCurrentMonth && (
            <button type="button" onClick={() => setPeriod(monthOptions()[1].value)} className={B.link}>
              See {monthOptions()[1].label}
            </button>
          )}
        </div>
      ) : people.length === 0 ? (
        <div className="p-6 text-center"><Muted>No one matches these filters.</Muted></div>
      ) : (
        <div className="overflow-x-auto">
          <table className={T.table}>
            <thead>
              <tr className={T.headRow}>
                <SortHeader label="Person" k="name" sort={sort ?? defaultSort} onSort={onSort} />
                <SortHeader label="Main kind of work" k="work" sort={sort ?? defaultSort} onSort={onSort} />
                <SortHeader label="Measured spend" k="spend" sort={sort ?? defaultSort} onSort={onSort} align="right" />
                <SortHeader label="vs last month" k="change" sort={sort ?? defaultSort} onSort={onSort} align="right" />
                <SortHeader label="Better routes" k="routes" sort={sort ?? defaultSort} onSort={onSort} />
                {limitsOn && <SortHeader label="Anthropic limit" k="limit" sort={sort ?? defaultSort} onSort={onSort} />}
                <th scope="col" className={T.th}><span className="sr-only">Action</span></th>
              </tr>
            </thead>
            <tbody>
              {people.map(p => {
                const href = reviewHref(p, period);
                return (
                  <tr key={p.userId ?? p.email ?? p.displayName} className={cx(T.row, 'align-top')}>
                    <td className={T.td}>
                      <span className="block font-medium text-[#0A0A0A]">{p.displayName}</span>
                      <span className="block text-[13px] text-[#8F8F8F]">{p.department ?? 'No department'}</span>
                      {(p.automatedRuns ?? 0) > 0 && <span className="block text-[13px] text-[#8F8F8F] tabular-nums">{(p.automatedRuns ?? 0).toLocaleString('en-GB')} automated run{p.automatedRuns === 1 ? '' : 's'}</span>}
                      {p.pendingRequestAt && <span className="inline-block mt-1"><Tag tone="warn">Asked for more</Tag></span>}
                    </td>
                    <td className={T.td}>
                      {p.mainWork ? (
                        <>
                          <span className="block text-[#0A0A0A]">{p.mainWork.label}</span>
                          <span className="block text-[13px] text-[#8F8F8F] tabular-nums">{pct(p.mainWork.share)} of their spend · {surfaceName(p.mainWork.surface, !!data.openai)}</span>
                        </>
                      ) : <span className="text-[13px] text-[#8F8F8F]">{p.totalUsd > 0 ? 'Not classified yet' : 'Not measured'}</span>}
                    </td>
                    <td className={T.tdRight}>
                      {p.unpricedOnly
                        ? <span className="text-[13px] text-[#B54708]">Not priced</span>
                        : <><span className="block text-[#0A0A0A]">{money(p.totalUsd)}</span><SplitBar p={p} openai={!!data.openai} /></>}
                    </td>
                    <td className={T.tdRight}><Change now={p.totalUsd} prior={p.priorTotalUsd} pace={pace} /></td>
                    <td className={T.td}>
                      {p.routeCount > 0
                        ? <Tag tone="measured">{p.routeCount} route{p.routeCount === 1 ? '' : 's'}</Tag>
                        : <span className="text-[13px] text-[#B3B3B3]">None</span>}
                    </td>
                    {limitsOn && (
                      <td className={T.td}>
                        {p.anthropic ? (
                          <>
                            <LimitBar share={p.anthropic.shareUsed} nearShare={nearShare} />
                            <span className="block text-[13px] text-[#8F8F8F] mt-1 tabular-nums">
                              {money(p.anthropic.spend, p.anthropic.currency)} of {p.anthropic.limit === null ? 'no limit' : money(p.anthropic.limit, p.anthropic.currency)}
                            </span>
                          </>
                        ) : <span className="text-[13px] text-[#8F8F8F]">Not in Anthropic org</span>}
                      </td>
                    )}
                    <td className={cx(T.td, 'text-right')}>
                      {href
                        ? <Link href={href} className={B.link}>Review</Link>
                        : <span className="text-[13px] text-[#8F8F8F]">Not seen by Command Centre</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="px-4 py-2.5 border-t border-[#F2F2F2] flex flex-col gap-1.5 text-[13px] text-[#8F8F8F]">
        <div className="flex gap-4 flex-wrap">
          {!openaiOnly && <span className="flex items-center gap-1.5"><span className="w-2.5 h-1 rounded-full" style={{ background: SURFACE_COLOR.cowork }} />{surfaceName('cowork', !!data.openai)}</span>}
          {!openaiOnly && <span className="flex items-center gap-1.5"><span className="w-2.5 h-1 rounded-full" style={{ background: SURFACE_COLOR.code }} />{surfaceName('code', !!data.openai)}</span>}
          {data.openai && <span className="flex items-center gap-1.5"><span className="w-2.5 h-1 rounded-full" style={{ background: PRODUCT_COLOR.chatgpt_chat }} />ChatGPT</span>}
          {data.openai && <span className="flex items-center gap-1.5"><span className="w-2.5 h-1 rounded-full" style={{ background: PRODUCT_COLOR.codex }} />Codex</span>}
        </div>
        <p className="m-0 leading-5">
          {openaiOnly
            ? <>ChatGPT and Codex spend from OpenAI&apos;s Compliance API, priced at OpenAI&apos;s USD token rates: the same figures as FinOps. ChatGPT spend per conversation is an estimate, since OpenAI reports cost per hour.</>
            : data.openai
            ? <>Measured by Command Centre: Claude Code and Cowork spend from telemetry, and ChatGPT and Codex spend from OpenAI&apos;s Compliance API priced at OpenAI&apos;s USD token rates, the same figures as FinOps. Claude Chat isn&apos;t included.</>
            : <>Measured by Command Centre: Code and Cowork spend from telemetry, the same figures as FinOps. Chat isn&apos;t included.</>}
          {data.isCurrentMonth && ' The change compares this month so far with last month scaled to the same point in the month.'}
          {' '}Kind of work is AI-judged. The bar under each amount splits it {data.openai ? 'by product' : 'into Cowork and Code'}, coloured as in the key above.
          {limitsOn && " Anthropic's figures cover every surface, including Chat, so they can differ from Command Centre's."}
          {data.unpricedModels.length > 0 && ` Not priced, so left out: ${data.unpricedModels.map(m => formatModelLabel(m).label).join(', ')}.`}
        </p>
      </div>
    </Panel>
  ) : null;

  return (
    <>
      <TopBar title="Spend Review" subtitle="What each person's AI spend goes on, and whether there's a better route" />
      <PageBody>
        <Toolbar left="Open a person to see their spend by kind of work, what it produced, and the skills, connectors and models colleagues use for the same work.">
          <UpdatedLine at={data?.updatedAt} refreshing={refreshing} onRefresh={() => { setRefreshing(true); setRefreshKey(k => k + 1); }} />
          <MonthPicker value={period} onChange={p => { setRefreshKey(0); setPeriod(p); }} />
        </Toolbar>

        {loading && <LoadingSpinner />}
        {error && <Notice tone="error">{error}</Notice>}

        {!loading && data && s && (
          <>
            {data.isCurrentMonth && !openaiOnly && <LimitsNotice status={data.limits.status} />}

            {s.people > 0 && (
              <Strip cols={limitsOn ? 5 : 4}>
                <Figure
                  label={data.isCurrentMonth ? 'Spend so far' : 'Spend'}
                  value={money(s.totalUsd)}
                  tone="measured"
                  title={vendorSplit ? `Claude ${money(vendorSplit.claudeUsd)} · ChatGPT and Codex ${money(vendorSplit.openaiUsd)}` : undefined}
                  sub={vendorSplit ? (
                    s.priorTotalUsd !== null ? (
                      <span>
                        Claude <Change now={vendorSplit.claudeUsd} prior={s.priorVendors?.claudeUsd ?? null} pace={pace} />
                        {' · '}ChatGPT and Codex <Change now={vendorSplit.openaiUsd} prior={s.priorVendors?.openaiUsd ?? null} pace={pace} />
                        {' '}{data.isCurrentMonth ? 'against last month’s pace' : 'against last month'}
                      </span>
                    ) : <span className="tabular-nums">Claude {money(vendorSplit.claudeUsd)} · ChatGPT and Codex {money(vendorSplit.openaiUsd)}</span>
                  ) : s.priorTotalUsd !== null && <><Change now={s.totalUsd} prior={s.priorTotalUsd} pace={pace} /> {data.isCurrentMonth ? 'against last month’s pace' : 'against last month'}</>}
                />
                <Figure
                  label="Where it sits"
                  value={<>{s.people.toLocaleString('en-GB')}<span className="text-[14px] font-normal text-[#4D4D4D] tracking-normal"> {s.people === 1 ? 'person' : 'people'} spent it</span></>}
                  sub={s.halfSpendPeople !== null
                    ? `${s.halfSpendPeople.toLocaleString('en-GB')} of them spent 50%.`
                    : 'Too few people with spend to split'}
                />
                <Figure
                  label="Biggest kind of work"
                  title={s.topWork.map(w => `${w.label} (${surfaceName(w.surface, !!data.openai)}) ${pct(w.share)}`).join(' · ') || undefined}
                  value={s.topWork.length === 0
                    ? <span className="text-[14px] font-normal text-[#8F8F8F] tracking-normal">Not classified yet</span>
                    // A label, not a number: one step down from the figure size and free to wrap, so it never cuts off.
                    : <span className="block text-[14px] leading-5 tracking-normal [overflow-wrap:anywhere]">{s.topWork[0].label}</span>}
                  sub={s.topWork.length > 0 ? `${pct(s.topWork[0].share)} · ${surfaceName(s.topWork[0].surface, !!data.openai)}` : undefined}
                />
                <Figure
                  label="Better routes waiting"
                  value={<>{s.peopleWithRoutes}<span className="text-[14px] font-normal text-[#4D4D4D] tracking-normal"> {s.peopleWithRoutes === 1 ? 'person' : 'people'}</span></>}
                  sub={s.peopleWithRoutes > 0 ? 'See the list below' : 'No route colleagues’ work points to yet'}
                />
                {limitsOn && (
                  <Figure
                    label="Anthropic limits"
                    value={
                      <button type="button" onClick={() => { setOnlyNear(v => !v); setEveryoneOpen(true); }} aria-pressed={onlyNear} className="text-left hover:text-[#1F6F8B]">
                        {over}<span className="text-[14px] font-normal text-[#4D4D4D] tracking-normal"> over</span> · {near}<span className="text-[14px] font-normal text-[#4D4D4D] tracking-normal"> close</span>
                      </button>
                    }
                    sub={pending.length > 0 ? <span className="text-[#B54708]">{pending.length} asked for more</span> : 'No requests for more usage'}
                  />
                )}
              </Strip>
            )}

            {data.people.length > 0
              ? <BetterRoutes people={data.people} period={period} openai={!!data.openai} />
              : <Panel title="Better routes, proven savings first"><Muted>No one has spend this month yet.</Muted></Panel>}
            {requestsPanel}
            {rereadNotice}

            {/* Shown even with every board empty, so the board can say why. */}
            {boards.length > 0 && (
              <Fold title="Most efficient" sub="Lower cost than colleagues for the same kinds of work, with work as deep as theirs">
                {data.people.length > 0
                  ? <EfficiencyBoard boards={boards} period={period} top={data.topTier ?? topTierName(null, null)} />
                  : <Panel><Muted>No one has spend this month yet.</Muted></Panel>}
              </Fold>
            )}

            {data.people.length > 0 ? (
              <Fold title="Everyone" sub={`${data.people.length} ${data.people.length === 1 ? 'person' : 'people'}, with filters`} open={everyoneOpen} onOpenChange={setEveryoneOpen}>
                {peoplePanel}
              </Fold>
            ) : peoplePanel}
          </>
        )}
      </PageBody>
    </>
  );
}

export default function SpendReviewIndexPage() {
  return (
    <Suspense fallback={<LoadingSpinner />}>
      <SpendReviewIndex />
    </Suspense>
  );
}
