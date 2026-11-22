// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Fragment, useEffect, useState } from 'react';
import Link from 'next/link';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { type SurfaceSummary, type SurfaceSpend } from '@/components/finance/SurfaceTiles';
import {
  SpendTrendCard, ProjectionCard, ConcentrationCard, projectionShown, type SpendTrend,
} from '@/components/finance/FinopsCharts';
import Leaderboard, { type LeaderboardEntry } from '@/components/finance/Leaderboard';
import InsightCard, { type InsightFacts } from '@/components/finance/InsightCard';
import ModelEfficiencySection from '@/components/finance/ModelEfficiencySection';
import OfficeSpendPanel, { type OfficeSpendData } from '@/components/finance/OfficeSpendPanel';
import WhereItGoes from '@/components/finance/WhereItGoes';
import FinopsFold from '@/components/finance/FinopsFold';
import { PageBody, Toolbar, Panel, Strip, Figure, Tag, Pill, T, B, Notice, Empty, Bar, cx, Muted, LOAD_FAILED } from '@/components/precision/ui';
import { MIN_PROJECTION_DAYS } from '@/lib/finance/finops-projection';
import { useOpenAiOnly } from '@/components/shared/VendorSwitch';
import { useAskPageNote } from '@/components/ask/useAskAvailable';
import { sharedGet } from '@/components/shared/shared-get';

interface CodeTokens {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

interface ChargebackUser {
  userId: string;
  displayName: string;
  codeUsd: number;
  coworkUsd: number;
  /** ChatGPT and Codex, present when OpenAI's Compliance API is connected. */
  chatgptUsd?: number;
  codexUsd?: number;
  totalUsd: number;
  tokens?: CodeTokens;
}

interface ChargebackCentre {
  name: string;
  code?: string | null;
  totalUsd: number;
  codeUsd: number;
  coworkUsd: number;
  /** ChatGPT and Codex, present when OpenAI's Compliance API is connected. */
  chatgptUsd?: number;
  codexUsd?: number;
  users: ChargebackUser[];
}

interface ChargebackReport {
  /** Parts the route could not build (seats, office): their panels say so. */
  failed?: string[];
  period: string;
  periodStart: number;
  periodEnd: number;
  monthToDate: boolean;
  grandTotalUsd: number;
  estimated: boolean;
  status: 'open' | 'closed';
  closedAt: number | null;
  unpricedModels: string[];
  coworkCostCoverage: { withCost: number; total: number };
  codeTokens?: { input: number; output: number; cacheWrite: number; cacheRead: number };
  cacheSavingsUsd?: number | null;
  costCentres: ChargebackCentre[];
  unallocated: { totalUsd: number; users: ChargebackUser[] };
  /** By-surface spend + token summary (Chat/Code/Cowork). Absent on old closed snapshots. */
  surfaces?: SurfaceSummary;
  /** Top spenders across all cost centres + unallocated. Absent on old closed snapshots. */
  leaderboard?: LeaderboardEntry[];
  /** Server-computed month-end run-rate projection. null for historical periods; absent on old closed snapshots. */
  projection?: { projected: number; daysElapsed: number; daysInMonth: number } | null;
  /** Claude's and OpenAI's projected month-end spend, each from its own month-to-date spend. null without the vendor split. */
  projectionByVendor?: { claudeUsd: number; openaiUsd: number } | null;
  /** Server-computed deterministic facts + optional grounded narrative. Absent on old closed snapshots. */
  insight?: { facts: InsightFacts; narrative: string | null };
  /** Wasted-seats estimate (licensed vs active-in-30d). null when licensedSeats is unset/invalid. Absent on old closed snapshots. */
  seats?: {
    licensed: number;
    activeUsers30d: number;
    unused: number;
    monthlyPriceUsd: number | null;
    estUnusedUsd: number | null;
  } | null;
  /** Claude / OpenAI split; present when OpenAI's Compliance API has sent data. */
  vendors?: { claudeUsd: number; openaiUsd: number };
  openaiUnpricedModels?: string[];
  /** The ChatGPT licence: seats x monthly price, charged apart from usage. null when no seat count is set. */
  chatgptSeats?: {
    licensed: number;
    activeUsers30d: number;
    unused: number;
    monthlyPriceUsd: number | null;
    monthlyLicenceUsd: number | null;
  } | null;
  /** Claude in Office, estimated from tokens; never in the totals. null without Office activity. */
  office?: OfficeSpendData | null;
}

/** Shown when the server refuses the role, which is not a load failure. */
const FORBIDDEN = 'FinOps is for admins and managers.';

const fmtUsd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const fmtTokens = (n: number) => n.toLocaleString('en-US');

const fmtTokensCompact = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B`
  : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M`
  : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K`
  : String(n);

const tokensTotal = (t: CodeTokens) => t.input + t.output + t.cacheWrite + t.cacheRead;
const tokensBreakdown = (t: CodeTokens) =>
  `${fmtTokens(t.input)} in · ${fmtTokens(t.output)} out · ${fmtTokens(t.cacheWrite)} cache-write · ${fmtTokens(t.cacheRead)} cache-read`;

/** Native `title` tooltip text for the headline token count — one line per surface. */
function surfaceTokensTitle(surfaces: SurfaceSummary): string {
  const line = (label: string, s: SurfaceSpend) =>
    s.basis === 'dormant'
      ? `${label}: dormant (not captured)`
      : `${label}: ${fmtTokensCompact(tokensTotal(s.tokens))} tokens, ${tokensBreakdown(s.tokens)}`;
  if (surfaces.chatgpt && surfaces.codex) {
    return [
      line('Claude Chat', surfaces.chat), line('Claude Code', surfaces.code), line('Claude Cowork', surfaces.cowork),
      line('ChatGPT', surfaces.chatgpt), line('Codex', surfaces.codex),
    ].join('\n');
  }
  return [line('Chat', surfaces.chat), line('Code', surfaces.code), line('Cowork', surfaces.cowork)].join('\n');
}

/** Plain-wording data-quality notes — only surfaced when there's something worth flagging. */
function buildDataQualityNotes(report: ChargebackReport, includeUnallocated = true): string[] {
  const notes: string[] = [];
  // The figure strip already shows unallocated spend, so the warning under it leaves it out.
  if (includeUnallocated && report.unallocated.totalUsd > 0) {
    notes.push(`${fmtUsd(report.unallocated.totalUsd)} is unallocated: no department on file for those users.`);
  }
  if (report.unpricedModels.length > 0) {
    notes.push(
      report.unpricedModels.length === 1
        ? `1 model has no rate set: add "${report.unpricedModels[0]}" in Admin.`
        : `${report.unpricedModels.length} models have no rate set: add them in Admin.`
    );
  }
  const openaiUnpriced = report.openaiUnpricedModels ?? [];
  if (openaiUnpriced.length > 0) {
    notes.push(
      openaiUnpriced.length === 1
        ? `1 ChatGPT or Codex model has no rate set, so its usage is not counted: add "${openaiUnpriced[0]}" in Admin → Developer Pulse → Rates.`
        : `${openaiUnpriced.length} ChatGPT or Codex models have no rate set, so their usage is not counted: add them in Admin → Developer Pulse → Rates.`
    );
  }
  const gap = report.coworkCostCoverage.total - report.coworkCostCoverage.withCost;
  if (gap > 0) {
    notes.push(`${gap} of ${report.coworkCostCoverage.total} Cowork requests are missing cost data.`);
  }
  return notes;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** The month before `period` ("2026-11" gives "October"), for the projection's comparison. */
function priorMonthName(period: string): string {
  const m = Number(period.split('-')[1]);
  return m >= 1 && m <= 12 ? MONTH_NAMES[(m + 10) % 12] : 'last month';
}

/**
 * The projection against last month, in words. The percentage is the one
 * This month in cost already shows (insight.facts.projection.vsPriorPct),
 * rounded the same way.
 */
function paceVsPrior(vsPriorPct: number | null | undefined, prior: string): string | null {
  if (vsPriorPct == null) return null;
  const r = Math.round(vsPriorPct);
  if (r === 0) return `About the same as ${prior}'s total`;
  return `${Math.abs(r)}% ${r < 0 ? 'less' : 'more'} than ${prior}'s total`;
}

/** Cost centre rows shown before "Show all". */
const CENTRE_ROWS_SHOWN = 3;

function buildMonthOptions(): { value: string; label: string }[] {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonthIdx = now.getMonth(); // 0-based
  const options: { value: string; label: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(currentYear, currentMonthIdx - i, 1);
    const year = d.getFullYear();
    const monthIdx = d.getMonth();
    const value = `${year}-${String(monthIdx + 1).padStart(2, '0')}`;
    const isCurrent = i === 0;
    const label = isCurrent
      ? `${MONTH_NAMES[monthIdx]} ${year} (month to date)`
      : `${MONTH_NAMES[monthIdx]} ${year}`;
    options.push({ value, label });
  }
  return options;
}

/** The people inside one cost centre, as a nested flush table under its row. */
function UserTable({ users, openai, openaiOnly }: { users: ChargebackUser[]; openai: boolean; openaiOnly: boolean }) {
  const claude = !openai || !openaiOnly;
  const cell = 'px-2 py-2 text-right text-[#666666] tabular-nums';
  return (
    <table className={cx(T.table, 'text-[13px]')}>
      <thead>
        <tr className={cx(T.headRow, 'bg-[#FAFAFA]')}>
          <th scope="col" className={cx(T.th, '!pl-10')}>Person</th>
          {claude && <th scope="col" className={T.thRight}>{openai ? 'Claude Code tokens' : 'Tokens'}</th>}
          {claude && <th scope="col" className={T.thRight}>{openai ? 'Claude Code' : 'Code'}</th>}
          {claude && <th scope="col" className={T.thRight}>{openai ? 'Claude Cowork' : 'Cowork'}</th>}
          {openai && <th scope="col" className={T.thRight}>ChatGPT</th>}
          {openai && <th scope="col" className={T.thRight}>Codex</th>}
          <th scope="col" className={T.thRight}>Total</th>
        </tr>
      </thead>
      <tbody>
        {users.map(u => (
          <tr key={u.userId} className="border-t border-[#F2F2F2]">
            <td className="px-2 py-2 pl-10 text-[#0A0A0A]">{u.displayName}</td>
            {claude && (
              <td
                className="px-2 py-2 text-right text-[#8F8F8F] tabular-nums"
                title={u.tokens ? tokensBreakdown(u.tokens) : undefined}
              >
                {u.tokens && tokensTotal(u.tokens) > 0 ? fmtTokensCompact(tokensTotal(u.tokens)) : 'not measured'}
              </td>
            )}
            {claude && <td className={cell}>{fmtUsd(u.codeUsd)}</td>}
            {claude && <td className={cell}>{fmtUsd(u.coworkUsd)}</td>}
            {openai && <td className={cell}>{fmtUsd(u.chatgptUsd ?? 0)}</td>}
            {openai && <td className={cell}>{fmtUsd(u.codexUsd ?? 0)}</td>}
            <td className="px-2 py-2 pr-4 text-right font-medium text-[#0A0A0A] tabular-nums">{fmtUsd(u.totalUsd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CentreRow({
  name,
  code,
  totalUsd,
  users,
  grandTotalUsd,
  unallocated = false,
  open,
  onToggle,
  openai,
  openaiOnly,
}: {
  name: string;
  code?: string | null;
  totalUsd: number;
  users: ChargebackUser[];
  grandTotalUsd: number;
  unallocated?: boolean;
  open: boolean;
  onToggle: () => void;
  openai: boolean;
  openaiOnly: boolean;
}) {
  const share = grandTotalUsd > 0 ? totalUsd / grandTotalUsd : 0;
  return (
    <Fragment>
      <tr className={cx(T.row, 'cursor-pointer')} onClick={onToggle}>
        <td className={T.td}>
          <button
            type="button"
            aria-expanded={open}
            onClick={e => { e.stopPropagation(); onToggle(); }}
            className={cx('inline-flex items-center gap-1.5 text-left font-medium hover:underline', unallocated ? 'text-[#B54708]' : 'text-[#0A0A0A]')}
          >
            <span className="text-[#B3B3B3] inline-block w-3 font-normal" aria-hidden="true">{open ? '▾' : '▸'}</span>
            {name}
          </button>
          {code && <span className="ml-2 font-mono text-[12px] text-[#8F8F8F]" title="GL code">{code}</span>}
        </td>
        <td className={cx(T.tdRight, 'text-[#666666]')}>{users.length}</td>
        <td className={cx(T.td, 'w-[30%]')}>
          <div className="flex items-center gap-2">
            <div className="flex-1"><Bar pct={share * 100} tone={unallocated ? 'warn' : 'measured'} height={6} /></div>
            <span className="text-[13px] text-[#8F8F8F] tabular-nums w-9 text-right">{Math.round(share * 100)}%</span>
          </div>
        </td>
        <td className={cx(T.tdRight, 'font-medium')}>{fmtUsd(totalUsd)}</td>
      </tr>
      {open && (
        <tr className="border-t border-[#F2F2F2]">
          <td colSpan={4} className="p-0">
            <div className="overflow-x-auto"><UserTable users={users} openai={openai} openaiOnly={openaiOnly} /></div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

export default function CostChargebackPage() {
  const [monthOptions] = useState(() => buildMonthOptions());
  const [period, setPeriod] = useState(() => buildMonthOptions()[0].value);
  useAskPageNote('finops', `FinOps shows the calendar month ${period}.`);
  // monthOptions[0] is always the current calendar month (buildMonthOptions'
  // i===0 case) — the seats line is a renewal-negotiation number that only
  // makes sense read against "the last 30 days" as of now, not a past period.
  const isCurrentMonth = period === monthOptions[0]?.value;
  const [report, setReport] = useState<ChargebackReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notEnabled, setNotEnabled] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [trend, setTrend] = useState<SpendTrend | null>(null);
  const [openCentres, setOpenCentres] = useState<Set<string>>(() => new Set());
  const [allCentreRows, setAllCentreRows] = useState(false);
  /** People with a better route this month, from Spend Review. null hides Where to save. */
  // Spend Review's count; null while loading or when Spend Review is off or not this role's; 'failed' on an error.
  const [peopleWithRoutes, setPeopleWithRoutes] = useState<number | null | 'failed'>(null);
  // Only OpenAI connected: no Claude tiles, columns or notes.
  const openaiOnly = useOpenAiOnly();

  // FinOps is for admins and managers. Wait for the role before asking for any figures, so
  // other roles see why rather than a page of refused requests. If the check itself fails,
  // ask anyway and let the server decide.
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    sharedGet('/api/admin/session').then(r => r.json())
      .then(d => {
        const role = d.authenticated ? d.user?.role : undefined;
        if (role === 'admin') setIsAdmin(true);
        setAllowed(role === 'admin' || role === 'manager');
      })
      .catch(() => setAllowed(true));
  }, []);

  useEffect(() => {
    if (allowed !== true) return;
    fetch('/api/finance/trend?months=12')
      .then(r => (r.ok ? r.json() : null))
      .then(setTrend)
      .catch(() => {});
  }, [allowed]);

  useEffect(() => {
    if (allowed === null) return;
    if (!allowed) { setError(FORBIDDEN); setLoading(false); return; }
    setLoading(true);
    setError(null);
    setNotEnabled(false);
    fetch(`/api/finance/chargeback?period=${period}`)
      .then(r => {
        if (r.status === 404) { setNotEnabled(true); throw new Error('not enabled'); }
        if (r.status === 403) throw new Error(FORBIDDEN);
        if (!r.ok) throw new Error("Couldn't load this page. Try again.");
        return r.json();
      })
      .then(setReport)
      .catch(e => { if (e.message !== 'not enabled') setError(e.message); })
      .finally(() => setLoading(false));
  }, [period, refreshKey, allowed]);

  // Where to save: Spend Review's count for the same month. Any failure (off,
  // not allowed for this role, not built) hides the panel.
  useEffect(() => {
    if (allowed !== true) return;
    let cancelled = false;
    setPeopleWithRoutes(null);
    fetch(`/api/finance/spend-review?period=${encodeURIComponent(period)}`)
      .then(r => {
        // Off (404) or not this role's (403): no panel. Any other failure: the panel says so.
        if (r.status === 404 || r.status === 403) return null;
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then(d => {
        if (cancelled || d === null) return;
        const n = d?.summary?.peopleWithRoutes;
        setPeopleWithRoutes(typeof n === 'number' ? n : 'failed');
      })
      .catch(() => { if (!cancelled) setPeopleWithRoutes('failed'); });
    return () => { cancelled = true; };
  }, [period, allowed]);

  const handleClose = async () => {
    if (!window.confirm(`Close ${period}? This freezes an immutable snapshot for billing. It cannot be reopened.`)) return;
    setCloseError(null);
    try {
      const res = await fetch('/api/finance/chargeback/close', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ period }),
      });
      if (!res.ok) {
        const msg = res.status === 409 ? 'This period is already closed.' : res.status === 403 ? 'Only an admin can close a period.' : "Couldn't close the period. Try again.";
        setCloseError(msg); return;
      }
      setRefreshKey(k => k + 1);
    } catch { setCloseError('Close failed: network error.'); }
  };

  const toggleCentre = (key: string) => setOpenCentres(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  if (loading) return (
    <>
      <TopBar title="FinOps" subtitle="AI spend by cost centre, per month" />
      <LoadingSpinner />
    </>
  );

  if (notEnabled) return (
    <>
      <TopBar title="FinOps" subtitle="AI spend by cost centre, per month" />
      <PageBody>
        <Empty title="FinOps is not enabled on this instance">An admin can enable it in configuration.</Empty>
      </PageBody>
    </>
  );

  if (error) return (
    <>
      <TopBar title="FinOps" subtitle="AI spend by cost centre, per month" />
      <PageBody>
        {error === FORBIDDEN
          ? <Notice tone="info" title="Not available">{error}</Notice>
          : <Notice tone="error" title="Failed to load.">{error}</Notice>}
      </PageBody>
    </>
  );

  const monthPicker = (
    <label className="inline-flex items-center gap-1.5 text-[13px] text-[#666666]">
      Month
      <select
        value={period}
        onChange={e => setPeriod(e.target.value)}
        className={B.select}
      >
        {monthOptions.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );

  if (!report) return null;

  const isEmpty = report.grandTotalUsd === 0 && report.costCentres.length === 0 && report.unallocated.users.length === 0;
  const dataQualityNotes = buildDataQualityNotes(report);
  const warningNotes = buildDataQualityNotes(report, false);
  const centreKeys = [
    ...report.costCentres.map(c => `centre:${c.name}`),
    ...(report.unallocated.users.length > 0 ? ['unallocated'] : []),
  ];
  const allOpen = centreKeys.length > 0 && centreKeys.every(k => openCentres.has(k));
  const centreCount = report.costCentres.length;
  // Top rows first (the report sorts centres by spend); Unallocated always shows, last.
  const shownCentres = allCentreRows ? report.costCentres : report.costCentres.slice(0, CENTRE_ROWS_SHOWN);
  const openai = report.vendors !== undefined;
  const claudeShown = !openai || !openaiOnly;
  const basisTag = !openai
    ? 'Code estimated · Cowork actual'
    : openaiOnly
      ? "ChatGPT and Codex at OpenAI's USD token rates"
      : "Claude Code estimated · Claude Cowork actual · ChatGPT and Codex at OpenAI's USD token rates";

  const exportButton = (
    <a href={`/api/finance/chargeback/export?period=${encodeURIComponent(period)}`} className={B.secondary}>
      Export CSV
    </a>
  );
  const closeButton = report.status === 'open' && isAdmin && !isEmpty && (
    <button type="button" onClick={handleClose} className={B.primary}>
      Close period
    </button>
  );
  // Export and Close sit in the By cost centre header; with no table they stay in the toolbar.
  const centrePanelShown = !isEmpty && centreKeys.length > 0;

  // On pace for: the projection card's own figure and cases.
  const projection = report.monthToDate ? report.projection ?? null : null;
  const pace = projection && projection.daysElapsed >= MIN_PROJECTION_DAYS
    ? projectionShown(projection, report.projectionByVendor ?? null, openaiOnly)
    : null;
  const paceWords = paceVsPrior(report.insight?.facts.projection?.vsPriorPct, priorMonthName(period));
  const notShown = (text: string) => <span className="text-[14px] font-normal tracking-normal text-[#8F8F8F]">{text}</span>;

  const unallocatedPeople = report.unallocated.users.length;
  const seatsShown = (report.chatgptSeats != null && isCurrentMonth) || (report.seats != null && isCurrentMonth && claudeShown);
  // Seats known but a past month, or failed to load: the fold still shows and says which.
  const seatsFailed = (report.failed ?? []).includes('seats');
  const seatsKnown = report.chatgptSeats != null || (report.seats != null && claudeShown);
  const officeFailed = (report.failed ?? []).includes('office');
  const officeShown = !!report.office && report.office.byProduct.length > 0;
  const estimateTag = <Tag tone="judged">Estimate</Tag>;

  return (
    <>
      <TopBar title="FinOps" subtitle="AI spend by cost centre, per month" />
      <PageBody>
        <Toolbar
          left={isAdmin ? <a href="/admin/cost-centres" className={B.link}>Manage cost centres</a> : undefined}
        >
          {monthPicker}
          {!centrePanelShown && exportButton}
          {!centrePanelShown && closeButton}
        </Toolbar>

        {closeError && !centrePanelShown && <Notice tone="error">{closeError}</Notice>}

        {isEmpty ? (
          <Empty title={`No AI spend recorded for ${monthOptions.find(o => o.value === period)?.label ?? period}.`} />
        ) : (
          <>
            {/* 1. The answer: four figures */}
            <Strip cols={4}>
              <Figure
                label={report.monthToDate ? 'Spend so far' : 'Spend'}
                value={fmtUsd(report.grandTotalUsd)}
                tone="measured"
                sub={openai && !openaiOnly && report.vendors
                  ? `Claude ${fmtUsd(report.vendors.claudeUsd)} · ChatGPT and Codex ${fmtUsd(report.vendors.openaiUsd)}`
                  : undefined}
              />
              <Figure
                label={<span className="inline-flex items-center gap-2">On pace for {estimateTag}</span>}
                value={pace ? fmtUsd(pace.totalUsd) : notShown('Not projected')}
                tone="judged"
                sub={!projection
                  ? 'Only shown for the current, in-progress month.'
                  : !pace
                    ? `Too early in the month to project. Day ${projection.daysElapsed} of ${projection.daysInMonth}.`
                    : paceWords ?? `Day ${projection.daysElapsed} of ${projection.daysInMonth}`}
              />
              <Figure
                label="Unallocated"
                value={fmtUsd(report.unallocated.totalUsd)}
                tone="measured"
                sub={
                  <>
                    {unallocatedPeople === 0
                      ? 'Everyone has a department'
                      : `${unallocatedPeople} ${unallocatedPeople === 1 ? 'person' : 'people'} with no department`}
                    {isAdmin && unallocatedPeople > 0 && (
                      <>{' · '}<Link href="/admin/users" className={B.link}>Assign</Link></>
                    )}
                  </>
                }
              />
              <Figure
                label={<span className="inline-flex items-center gap-2">Caching saved {estimateTag}</span>}
                value={report.cacheSavingsUsd != null ? fmtUsd(report.cacheSavingsUsd) : notShown('Not measured')}
                tone="judged"
                sub={report.cacheSavingsUsd != null ? 'what re-read conversation would have cost at full price' : undefined}
              />
            </Strip>

            {/* Status of the month and how spend is priced */}
            <div className="flex flex-col gap-1.5">
              {(report.status === 'closed' || report.estimated) && (
                <div className="flex items-center gap-2 flex-wrap">
                  {report.status === 'closed' && <Pill>Closed</Pill>}
                  {report.status === 'closed' && report.closedAt && (
                    <span className="text-[13px] text-[#8F8F8F]">
                      Closed on {new Date(report.closedAt * 1000).toLocaleDateString()}
                    </span>
                  )}
                  {report.estimated && (
                    <Tag tone="measured">
                      {report.status === 'closed' ? 'Estimated: closed with estimated spend' : 'Estimated, for visibility, not billing'}
                    </Tag>
                  )}
                </div>
              )}
              <details className="text-[13px] text-[#8F8F8F]">
                <summary className="cursor-pointer select-none hover:text-[#4D4D4D] w-fit">
                  {!openai ? 'Why this differs from your Anthropic invoice' : openaiOnly ? 'Why this differs from your OpenAI invoice' : 'Why this differs from your Anthropic and OpenAI invoices'}
                </summary>
                {claudeShown && (
                  <p className="m-0 mt-1.5 leading-5 max-w-2xl">
                    {openai ? 'Claude Code' : 'Code'} spend is estimated from token usage at published list rates. Actual Anthropic, Bedrock, or
                    Vertex billing may include volume discounts, credits, or different regional pricing. {openai ? 'Claude Cowork' : 'Cowork'} spend
                    reflects the actual per-request API cost recorded at the time. Neither figure includes {openai ? '' : 'non-Claude usage, '}taxes or
                    account-level adjustments.
                  </p>
                )}
                {openai && (
                  <p className="m-0 mt-1.5 leading-5 max-w-2xl">
                    ChatGPT and Codex spend is priced from token usage at OpenAI&apos;s published USD rates for token-based
                    Enterprise contracts. A credit-based contract, negotiated discounts, seat fees, taxes and account-level
                    adjustments are not reflected. The ChatGPT licence is shown on its own line, never added to usage.
                  </p>
                )}
              </details>
            </div>

            {warningNotes.length > 0 && (
              <Notice tone="warn">
                {warningNotes.map((note, i) => (
                  <span key={i} className="block">{note}</span>
                ))}
              </Notice>
            )}

            {/* 2. Where it goes: one bar by product */}
            {report.surfaces && (
              <WhereItGoes
                surfaces={report.surfaces}
                openaiOnly={openaiOnly}
                right={
                  <>
                    {tokensTotal(report.surfaces.total.tokens) > 0 && (
                      <span
                        className="text-[13px] text-[#8F8F8F] tabular-nums cursor-help"
                        title={surfaceTokensTitle(report.surfaces)}
                      >
                        {fmtTokensCompact(tokensTotal(report.surfaces.total.tokens))} tokens
                      </span>
                    )}
                    {/* A long pricing note: wraps on narrow screens instead of widening the page. */}
                    <span className="text-[12px] leading-4 text-[#666666] border border-[#EAEAEA] rounded-[10px] px-2 py-0.5">{basisTag}</span>
                  </>
                }
              />
            )}

            {/* 3. Cost centres, Unallocated last */}
            {centrePanelShown ? (
              <>
                {closeError && <Notice tone="error">{closeError}</Notice>}
                <Panel
                  title="By cost centre"
                  subtitle={`${centreCount} centre${centreCount === 1 ? '' : 's'}${report.unallocated.users.length > 0 ? ', plus unallocated' : ''}`}
                  right={
                    <>
                      <button
                        type="button"
                        className={B.link}
                        onClick={() => setOpenCentres(allOpen ? new Set() : new Set(centreKeys))}
                      >
                        {allOpen ? 'Hide people' : 'Show people'}
                      </button>
                      {exportButton}
                      {closeButton}
                    </>
                  }
                  flush
                >
                  <div className="overflow-x-auto">
                    <table className={T.table}>
                      <thead>
                        <tr className={T.headRow}>
                          <th scope="col" className={T.th}>Cost centre</th>
                          <th scope="col" className={T.thRight}>People</th>
                          <th scope="col" className={T.th}>Share</th>
                          <th scope="col" className={T.thRight}>Spend</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shownCentres.map(centre => (
                          <CentreRow
                            key={centre.name}
                            name={centre.name}
                            code={centre.code}
                            totalUsd={centre.totalUsd}
                            users={centre.users}
                            grandTotalUsd={report.grandTotalUsd}
                            open={openCentres.has(`centre:${centre.name}`)}
                            onToggle={() => toggleCentre(`centre:${centre.name}`)}
                            openai={openai}
                            openaiOnly={openaiOnly}
                          />
                        ))}
                        {report.unallocated.users.length > 0 && (
                          <CentreRow
                            name="Unallocated"
                            totalUsd={report.unallocated.totalUsd}
                            users={report.unallocated.users}
                            grandTotalUsd={report.grandTotalUsd}
                            unallocated
                            open={openCentres.has('unallocated')}
                            onToggle={() => toggleCentre('unallocated')}
                            openai={openai}
                            openaiOnly={openaiOnly}
                          />
                        )}
                      </tbody>
                    </table>
                  </div>
                  {report.costCentres.length > CENTRE_ROWS_SHOWN && (
                    <div className="px-4 py-2.5 border-t border-[#F2F2F2]">
                      <button
                        type="button"
                        className={B.link}
                        aria-expanded={allCentreRows}
                        onClick={() => setAllCentreRows(v => !v)}
                      >
                        {allCentreRows ? `Show the top ${CENTRE_ROWS_SHOWN} only` : `Show all ${centreKeys.length} rows`}
                      </button>
                    </div>
                  )}
                </Panel>
              </>
            ) : !isEmpty ? <Panel title="By cost centre"><Muted>No spend is set against a cost centre this month.</Muted></Panel> : null}

            {/* 4. Where to save: Spend Review's count, for the same month */}
            {typeof peopleWithRoutes === 'number' ? (
              <Panel
                title="Where to save"
                badge={estimateTag}
                right={<Link href={`/finops/spend-review?period=${encodeURIComponent(period)}`} className={B.link}>Open Spend Review</Link>}
              >
                <p className="m-0 text-[13px] leading-5 text-[#333333]">
                  {peopleWithRoutes === 0
                    ? 'No one has a better route for their work yet: no skill, connector or model colleagues use for the same work.'
                    : `${peopleWithRoutes} ${peopleWithRoutes === 1 ? 'person has' : 'people have'} a better route for their work: a skill, connector or model colleagues use for the same work.`}
                </p>
              </Panel>
            ) : peopleWithRoutes === 'failed' ? <Panel title="Where to save" badge={estimateTag}><Muted>{LOAD_FAILED}</Muted></Panel> : null}

            {/* 5. Detail, folded */}
            <FinopsFold title="Spend trend and month-end projection">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <SpendTrendCard trend={trend} openaiOnly={openaiOnly} />
                <ProjectionCard
                  monthToDate={report.monthToDate}
                  projection={report.projection ?? null}
                  byVendor={report.projectionByVendor ?? null}
                  openaiOnly={openaiOnly}
                />
              </div>
            </FinopsFold>

            {/* Self-gated on financeModelEfficiencyEnabled (route 404s when off: the section and its row hide). */}
            <FinopsFold title="Model efficiency and cost drivers" hideWhenEmpty>
              <ModelEfficiencySection period={period} />
            </FinopsFold>

            {/* Claude in Office and Google: an estimate, never in the totals */}
            {officeShown ? (
              <FinopsFold title="Claude in Office and Google (estimate)">
                <OfficeSpendPanel data={report.office} />
              </FinopsFold>
            ) : officeFailed ? <FinopsFold title="Claude in Office and Google (estimate)"><Panel><Muted>{LOAD_FAILED}</Muted></Panel></FinopsFold> : null}

            <FinopsFold title="This month in cost and spend concentration">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                <InsightCard insight={report.insight ?? null} dataQualityNotes={dataQualityNotes} />
                <ConcentrationCard costCentres={report.costCentres} grandTotalUsd={report.grandTotalUsd} openaiOnly={openaiOnly} />
              </div>
            </FinopsFold>

            <FinopsFold title="Top spenders">
              <Leaderboard leaderboard={report.leaderboard ?? []} period={period} openaiOnly={openaiOnly} />
            </FinopsFold>

            {seatsShown ? (
              <FinopsFold title="Seats and licences">
                <Panel>
                  <div className="flex flex-col gap-2 text-[13px]">
                    {report.chatgptSeats != null && isCurrentMonth && (
                      <p className="m-0 text-[#4D4D4D]">
                        {report.chatgptSeats.monthlyLicenceUsd != null ? (
                          <>
                            ChatGPT licence: {report.chatgptSeats.licensed} seats at {fmtUsd(report.chatgptSeats.monthlyPriceUsd ?? 0)} a month, {fmtUsd(report.chatgptSeats.monthlyLicenceUsd)}.
                            OpenAI charges it apart from usage, so it is not in the figures above.
                          </>
                        ) : (
                          <>ChatGPT: {report.chatgptSeats.licensed} seats. Add the seat price in Admin → System → FinOps to see the licence cost.</>
                        )}
                        {' '}{report.chatgptSeats.activeUsers30d} of {report.chatgptSeats.licensed} seats used ChatGPT in the last 30 days.
                      </p>
                    )}
                    {report.seats != null && isCurrentMonth && claudeShown && (
                      <p className="m-0 text-[#4D4D4D]">
                        {report.seats.unused === 0 ? (
                          openai ? 'All licensed Claude seats active in the last 30 days.' : 'All licensed seats active in the last 30 days.'
                        ) : (
                          <>
                            {report.seats.unused} of {report.seats.licensed} licensed {openai ? 'Claude ' : ''}seats unused in the last 30 days
                            {report.seats.estUnusedUsd != null && (
                              <span className="text-[#1F6F8B]">
                                {' '}(about {fmtUsd(report.seats.estUnusedUsd)} a month, estimate, for visibility, not billing)
                              </span>
                            )}
                          </>
                        )}
                      </p>
                    )}
                  </div>
                </Panel>
              </FinopsFold>
            ) : seatsKnown || seatsFailed ? <FinopsFold title="Seats and licences"><Panel><Muted>{isCurrentMonth ? LOAD_FAILED : 'Only for the current month.'}</Muted></Panel></FinopsFold> : null}
          </>
        )}
      </PageBody>
    </>
  );
}
