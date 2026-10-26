// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { gapPct } from '@/lib/finance/spend-review-format';
import { MonthPicker, monthOptions, money, pct, ukDate, LimitsNotice, LimitBar, UpdatedLine, type LimitsStatus } from '@/components/spend-review/shared';
import { PageBody, Toolbar, Panel, PanelFoot, Strip, Figure, T, B, Tag, Chip, Notice, Muted, cx } from '@/components/precision/ui';
import { SURFACE_COLOR } from '@/lib/ui/chart-colours';
import { formatModelLabel } from '@/lib/pulse/code/model-label';

type Surface = 'code' | 'cowork';
interface LimitRow { period: string; limit: number | null; spend: number; currency: string; source: string; shareUsed: number | null }
interface Person {
  userId: string | null;
  displayName: string;
  email: string | null;
  department: string | null;
  codeUsd: number;
  coworkUsd: number;
  totalUsd: number;
  priorTotalUsd: number | null;
  unpricedOnly: boolean;
  mainWork: { label: string; surface: Surface; share: number } | null;
  routeCount: number;
  anthropic: LimitRow | null;
  pendingRequestAt: string | null;
}
interface Summary {
  totalUsd: number;
  priorTotalUsd: number | null;
  people: number;
  halfSpendPeople: number | null;
  topWork: { label: string; surface: Surface; share: number }[];
  peopleWithRoutes: number;
  orgRereadShare: number | null;
}
interface EfficiencyEntry { userId: string; displayName: string; department: string | null; vsColleagues: number; sessions: number; deepRate: number | null; peerDeepRate: number | null }

const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function monthLabel(p: string): string {
  const [y, m] = p.split('-').map(Number);
  return `${MONTH_LONG[m - 1]} ${y}`;
}

function EfficiencyBoard({ rows, period, boardPeriod }: { rows: EfficiencyEntry[]; period: string; boardPeriod: string }) {
  if (rows.length === 0) return null;
  const earlier = boardPeriod !== period;
  return (
    <Panel
      title={earlier || period !== monthOptions()[0].value ? `Most efficient in ${monthLabel(boardPeriod)}` : 'Most efficient this month'}
      subtitle="Lower cost than colleagues for the same kinds of work, with work as deep as theirs · at least 10 sessions"
      flush
    >
      {earlier && (
        <div className="px-4 pt-3">
          <Notice tone="warn">
            Showing {monthLabel(boardPeriod)}: nobody has 10 sessions in {monthLabel(period)} yet, which the comparison needs to be fair. The board switches to {monthLabel(period)} once enough work is in, usually within the first week.
          </Notice>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className={cx(T.table, earlier && 'mt-2')}>
          <thead>
            <tr className={T.headRow}>
              <th scope="col" className={T.th}><span className="sr-only">Rank</span></th>
              <th scope="col" className={T.th}>Person</th>
              <th scope="col" className={T.thRight}>Sessions</th>
              <th scope="col" className={T.thRight}>vs colleagues</th>
              <th scope="col" className={T.thRight}>Tier 3 share</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const below = 1 - r.vsColleagues;
              return (
                <tr key={r.userId} className={T.row}>
                  <td className={cx(T.td, 'w-8 text-[12px] text-[#B3B3B3] tabular-nums')}>{i + 1}</td>
                  <td className={T.td}>
                    <Link href={`/finops/spend-review/${encodeURIComponent(r.userId)}?period=${boardPeriod}`} className="font-medium text-[#0A0A0A] hover:text-[#245BF3] hover:underline">{r.displayName}</Link>
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
      <PanelFoot>
        Each person&apos;s typical session cost against colleagues doing the same kinds of work, weighted by where their money goes. Only people whose share of Tier 3 work is within 10 points of colleagues&apos; are ranked, so cheaper-because-shallower work doesn&apos;t count as efficient.
      </PanelFoot>
    </Panel>
  );
}

interface IndexData {
  period: string;
  isCurrentMonth: boolean;
  efficiency?: EfficiencyEntry[];
  /** The month the efficiency board covers: last month while this month is too new. */
  efficiencyPeriod?: string;
  updatedAt?: number;
  people: Person[];
  summary: Summary;
  unpricedModels: string[];
  limits: { status: LimitsStatus; fetchedAt: number | null; pendingCount: number };
  nearLimitShare: number;
}

const SURFACE_LABEL: Record<Surface, string> = { code: 'Code', cowork: 'Cowork' };
/** Below this much spend last month, the change reads New rather than a percentage. */
const MIN_PRIOR_FOR_CHANGE = 1;

function reviewHref(p: Person, period: string): string | null {
  return p.userId ? `/finops/spend-review/${encodeURIComponent(p.userId)}?period=${period}` : null;
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
  if (prior === null || prior < MIN_PRIOR_FOR_CHANGE) return now > 0 ? <span className="text-[13px] text-[#666666]">New</span> : <span className="text-[13px] text-[#B3B3B3]">—</span>;
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

function SplitBar({ code, cowork }: { code: number; cowork: number }) {
  const total = code + cowork;
  if (total <= 0) return null;
  return (
    <div className="flex h-1 w-[72px] rounded-full overflow-hidden gap-px bg-[#F2F2F2] ml-auto mt-1" title={`Cowork ${money(cowork)} · Code ${money(code)}`}>
      {/* Both halves are measured spend, in the shared surface colours. */}
      <div style={{ width: `${(cowork / total) * 100}%`, background: SURFACE_COLOR.cowork }} />
      <div style={{ width: `${(code / total) * 100}%`, background: SURFACE_COLOR.code }} />
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

/** A Strip cell for content that is not a single figure (a short list). Matches Figure's spacing. */
function ListCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="p-4 flex flex-col gap-1.5 min-w-0">
      <span className="text-[13px] text-[#666666]">{label}</span>
      {children}
    </div>
  );
}

function SpendReviewIndex() {
  const search = useSearchParams();
  const [period, setPeriod] = useState(() => search.get('period') || monthOptions()[0].value);
  const [data, setData] = useState<IndexData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [onlyRoutes, setOnlyRoutes] = useState(false);
  const [onlyNear, setOnlyNear] = useState(false);
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

  const limitsOn = data?.limits.status === 'ok' && data.isCurrentMonth;
  const nearShare = data?.nearLimitShare ?? 0.8;
  const departments = useMemo(() => [...new Set((data?.people ?? []).map(p => p.department).filter((d): d is string => !!d))].sort(), [data]);

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
  const boardRows = data?.efficiency ?? [];
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
  ) : null;
  const rereadNotice = s && s.orgRereadShare !== null && s.orgRereadShare >= 0.3 ? (
        <Notice tone="info" title={`${pct(s.orgRereadShare)} of the month's spend is Claude re-reading earlier conversation on every message.`}>
          That is normal for long Cowork sessions; a person is only flagged when they re-read clearly more than colleagues doing the same work.
        </Notice>
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
            {data.isCurrentMonth && <LimitsNotice status={data.limits.status} />}

            {s.people > 0 && (
              <Strip cols={limitsOn ? 5 : 4}>
                <Figure
                  label={data.isCurrentMonth ? 'Spend so far' : 'Spend'}
                  value={money(s.totalUsd)}
                  sub={s.priorTotalUsd !== null && <><Change now={s.totalUsd} prior={s.priorTotalUsd} pace={pace} /> {data.isCurrentMonth ? 'against last month’s pace' : 'against last month'}</>}
                />
                <Figure
                  label="Where it sits"
                  value={s.halfSpendPeople !== null
                    ? <>{s.halfSpendPeople}<span className="text-[14px] font-normal text-[#4D4D4D] tracking-normal"> {s.halfSpendPeople === 1 ? 'person makes' : 'people make'} up half</span></>
                    : s.people}
                  sub={`across ${s.people} ${s.people === 1 ? 'person' : 'people'}`}
                />
                <ListCell label="Biggest kinds of work">
                  {s.topWork.length === 0
                    ? <span className="text-[14px] text-[#8F8F8F]">Not classified yet</span>
                    : <ul className="m-0 p-0 list-none flex flex-col gap-0.5">
                        {s.topWork.map(w => (
                          <li key={w.surface + w.label} className="flex items-baseline justify-between gap-2 text-[14px]">
                            <span className="truncate text-[#0A0A0A]">{w.label} <span className="text-[12px] text-[#8F8F8F]">{SURFACE_LABEL[w.surface]}</span></span>
                            <span className="tabular-nums text-[#4D4D4D]">{pct(w.share)}</span>
                          </li>
                        ))}
                      </ul>}
                </ListCell>
                <Figure
                  label="Better routes waiting"
                  value={
                    <button type="button" onClick={() => setOnlyRoutes(v => !v)} disabled={s.peopleWithRoutes === 0} aria-pressed={onlyRoutes} className="text-left hover:text-[#245BF3] disabled:hover:text-inherit">
                      {s.peopleWithRoutes}<span className="text-[14px] font-normal text-[#4D4D4D] tracking-normal"> {s.peopleWithRoutes === 1 ? 'person' : 'people'}</span>
                    </button>
                  }
                  sub={s.peopleWithRoutes > 0 ? 'Colleagues doing the same work use a skill, connector or model they don’t' : 'No route colleagues’ work points to yet'}
                />
                {limitsOn && (
                  <Figure
                    label="Anthropic limits"
                    value={
                      <button type="button" onClick={() => setOnlyNear(v => !v)} aria-pressed={onlyNear} className="text-left hover:text-[#245BF3]">
                        {over}<span className="text-[14px] font-normal text-[#4D4D4D] tracking-normal"> over</span> · {near}<span className="text-[14px] font-normal text-[#4D4D4D] tracking-normal"> close</span>
                      </button>
                    }
                    sub={pending.length > 0 ? <span className="text-[#B54708]">{pending.length} asked for more</span> : 'No requests for more usage'}
                  />
                )}
              </Strip>
            )}

            {boardRows.length > 0 && (requestsPanel || rereadNotice) ? (
              <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-4 items-start">
                <EfficiencyBoard rows={boardRows} period={period} boardPeriod={data.efficiencyPeriod ?? period} />
                <div className="flex flex-col gap-4 min-w-0">
                  {requestsPanel}
                  {rereadNotice}
                </div>
              </div>
            ) : (
              <>
                <EfficiencyBoard rows={boardRows} period={period} boardPeriod={data.efficiencyPeriod ?? period} />
                {rereadNotice}
                {requestsPanel}
              </>
            )}

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
                              {p.pendingRequestAt && <span className="inline-block mt-1"><Tag tone="warn">Asked for more</Tag></span>}
                            </td>
                            <td className={T.td}>
                              {p.mainWork ? (
                                <>
                                  <span className="block text-[#0A0A0A]">{p.mainWork.label}</span>
                                  <span className="block text-[13px] text-[#8F8F8F] tabular-nums">{pct(p.mainWork.share)} of their spend · {SURFACE_LABEL[p.mainWork.surface]}</span>
                                </>
                              ) : <span className="text-[13px] text-[#8F8F8F]">{p.totalUsd > 0 ? 'Not classified yet' : '—'}</span>}
                            </td>
                            <td className={T.tdRight}>
                              {p.unpricedOnly
                                ? <span className="text-[13px] text-[#B54708]">Not priced</span>
                                : <><span className="block text-[#0A0A0A]">{money(p.totalUsd)}</span><SplitBar code={p.codeUsd} cowork={p.coworkUsd} /></>}
                            </td>
                            <td className={T.tdRight}><Change now={p.totalUsd} prior={p.priorTotalUsd} pace={pace} /></td>
                            <td className={T.td}>
                              {p.routeCount > 0
                                ? <Tag tone="measured">{p.routeCount} route{p.routeCount === 1 ? '' : 's'}</Tag>
                                : <span className="text-[13px] text-[#B3B3B3]">—</span>}
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
                  <span className="flex items-center gap-1.5"><span className="w-2.5 h-1 rounded-full" style={{ background: SURFACE_COLOR.cowork }} />Cowork</span>
                  <span className="flex items-center gap-1.5"><span className="w-2.5 h-1 rounded-full" style={{ background: SURFACE_COLOR.code }} />Code</span>
                </div>
                <p className="m-0 leading-5">
                  Measured by Command Centre: Code and Cowork spend from telemetry, the same figures as FinOps. Chat isn&apos;t included.
                  {data.isCurrentMonth && ' The change compares this month so far with last month scaled to the same point in the month.'}
                  {' '}Kind of work is AI-judged. The bar under each amount splits it into Cowork and Code, coloured as in the key above.
                  {limitsOn && " Anthropic's figures cover every surface, including Chat, so they can differ from Command Centre's."}
                  {data.unpricedModels.length > 0 && ` Not priced, so left out: ${data.unpricedModels.map(m => formatModelLabel(m).label).join(', ')}.`}
                </p>
              </div>
            </Panel>
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
