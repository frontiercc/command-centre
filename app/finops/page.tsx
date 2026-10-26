// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Fragment, useEffect, useState } from 'react';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import SurfaceTiles, { type SurfaceSummary, type SurfaceSpend } from '@/components/finance/SurfaceTiles';
import FinopsCharts, { type SpendTrend } from '@/components/finance/FinopsCharts';
import Leaderboard, { type LeaderboardEntry } from '@/components/finance/Leaderboard';
import InsightCard, { type InsightFacts } from '@/components/finance/InsightCard';
import ModelEfficiencySection from '@/components/finance/ModelEfficiencySection';
import { PageBody, Toolbar, Panel, Tag, Pill, T, B, Notice, Empty, Bar, cx } from '@/components/precision/ui';

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
  totalUsd: number;
  tokens?: CodeTokens;
}

interface ChargebackCentre {
  name: string;
  code?: string | null;
  totalUsd: number;
  codeUsd: number;
  coworkUsd: number;
  users: ChargebackUser[];
}

interface ChargebackReport {
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
}

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
  return [line('Chat', surfaces.chat), line('Code', surfaces.code), line('Cowork', surfaces.cowork)].join('\n');
}

/** Plain-wording data-quality notes — only surfaced when there's something worth flagging. */
function buildDataQualityNotes(report: ChargebackReport): string[] {
  const notes: string[] = [];
  if (report.unallocated.totalUsd > 0) {
    notes.push(`${fmtUsd(report.unallocated.totalUsd)} is unallocated: no department on file for those users.`);
  }
  if (report.unpricedModels.length > 0) {
    notes.push(
      report.unpricedModels.length === 1
        ? `1 model has no rate set: add "${report.unpricedModels[0]}" in Admin.`
        : `${report.unpricedModels.length} models have no rate set: add them in Admin.`
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
function UserTable({ users }: { users: ChargebackUser[] }) {
  return (
    <table className={cx(T.table, 'text-[13px]')}>
      <thead>
        <tr className={cx(T.headRow, 'bg-[#FAFAFA]')}>
          <th scope="col" className={cx(T.th, '!pl-10')}>Person</th>
          <th scope="col" className={T.thRight}>Tokens</th>
          <th scope="col" className={T.thRight}>Code</th>
          <th scope="col" className={T.thRight}>Cowork</th>
          <th scope="col" className={T.thRight}>Total</th>
        </tr>
      </thead>
      <tbody>
        {users.map(u => (
          <tr key={u.userId} className="border-t border-[#F2F2F2]">
            <td className="px-2 py-2 pl-10 text-[#0A0A0A]">{u.displayName}</td>
            <td
              className="px-2 py-2 text-right text-[#8F8F8F] tabular-nums"
              title={u.tokens ? tokensBreakdown(u.tokens) : undefined}
            >
              {u.tokens && tokensTotal(u.tokens) > 0 ? fmtTokensCompact(tokensTotal(u.tokens)) : '—'}
            </td>
            <td className="px-2 py-2 text-right text-[#666666] tabular-nums">{fmtUsd(u.codeUsd)}</td>
            <td className="px-2 py-2 text-right text-[#666666] tabular-nums">{fmtUsd(u.coworkUsd)}</td>
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
}: {
  name: string;
  code?: string | null;
  totalUsd: number;
  users: ChargebackUser[];
  grandTotalUsd: number;
  unallocated?: boolean;
  open: boolean;
  onToggle: () => void;
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
        </td>
        <td className={cx(T.tdMute, 'font-mono text-[13px]')}>{code || '—'}</td>
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
          <td colSpan={5} className="p-0">
            <div className="overflow-x-auto"><UserTable users={users} /></div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

export default function CostChargebackPage() {
  const [monthOptions] = useState(() => buildMonthOptions());
  const [period, setPeriod] = useState(() => buildMonthOptions()[0].value);
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

  useEffect(() => {
    fetch('/api/admin/session').then(r => r.json())
      .then(d => { if (d.authenticated && d.user?.role === 'admin') setIsAdmin(true); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/finance/trend?months=12')
      .then(r => (r.ok ? r.json() : null))
      .then(setTrend)
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setNotEnabled(false);
    fetch(`/api/finance/chargeback?period=${period}`)
      .then(r => {
        if (r.status === 404) { setNotEnabled(true); throw new Error('not enabled'); }
        if (!r.ok) throw new Error("Couldn't load this page. Try again.");
        return r.json();
      })
      .then(setReport)
      .catch(e => { if (e.message !== 'not enabled') setError(e.message); })
      .finally(() => setLoading(false));
  }, [period, refreshKey]);

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
        <Notice tone="error" title="Failed to load.">{error}</Notice>
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
  const centreKeys = [
    ...report.costCentres.map(c => `centre:${c.name}`),
    ...(report.unallocated.users.length > 0 ? ['unallocated'] : []),
  ];
  const allOpen = centreKeys.length > 0 && centreKeys.every(k => openCentres.has(k));
  const centreCount = report.costCentres.length;

  return (
    <>
      <TopBar title="FinOps" subtitle="AI spend by cost centre, per month" />
      <PageBody>
        <Toolbar
          left={isAdmin ? <a href="/admin/cost-centres" className={B.link}>Manage cost centres</a> : undefined}
        >
          {monthPicker}
          <a href={`/api/finance/chargeback/export?period=${period}`} className={B.secondary}>
            Export CSV
          </a>
          {report.status === 'open' && isAdmin && !isEmpty && (
            <button type="button" onClick={handleClose} className={B.primary}>
              Close period
            </button>
          )}
        </Toolbar>

        {closeError && <Notice tone="error">{closeError}</Notice>}

        {isEmpty ? (
          <Empty title={`No AI spend recorded for ${monthOptions.find(o => o.value === period)?.label ?? period}.`} />
        ) : (
          <>
            {/* Headline */}
            <div className="flex flex-col gap-2">
              <div className="flex items-baseline gap-3 flex-wrap">
                <span className="text-[36px] leading-10 font-semibold tracking-[-0.03em] tabular-nums text-[#0A0A0A]">{fmtUsd(report.grandTotalUsd)}</span>
                {report.surfaces && tokensTotal(report.surfaces.total.tokens) > 0 && (
                  <span
                    className="text-[14px] text-[#8F8F8F] tabular-nums cursor-help"
                    title={surfaceTokensTitle(report.surfaces)}
                  >
                    {fmtTokensCompact(tokensTotal(report.surfaces.total.tokens))} tokens
                  </span>
                )}
                {report.surfaces && <Tag>Code estimated · Cowork actual</Tag>}
                {report.status === 'closed' && <Pill>Closed</Pill>}
                {report.estimated && (
                  <Tag tone="measured">
                    {report.status === 'closed' ? 'Estimated: closed with estimated spend' : 'Estimated, for visibility, not billing'}
                  </Tag>
                )}
              </div>
              {report.status === 'closed' && report.closedAt && (
                <p className="m-0 text-[13px] text-[#8F8F8F]">
                  Closed on {new Date(report.closedAt * 1000).toLocaleDateString()}
                </p>
              )}
              {((report.cacheSavingsUsd != null && report.cacheSavingsUsd > 0) || (report.seats != null && isCurrentMonth)) && (
                <div className="flex gap-x-5 gap-y-1 flex-wrap text-[13px]">
                  {report.cacheSavingsUsd != null && report.cacheSavingsUsd > 0 && (
                    <span className="text-[#245BF3]">
                      Prompt caching saved about {fmtUsd(report.cacheSavingsUsd)} this month (estimate, at list rates)
                    </span>
                  )}
                  {report.seats != null && isCurrentMonth && (
                    <span className="text-[#4D4D4D]">
                      {report.seats.unused === 0 ? (
                        'All licensed seats active in the last 30 days.'
                      ) : (
                        <>
                          {report.seats.unused} of {report.seats.licensed} licensed seats unused in the last 30 days
                          {report.seats.estUnusedUsd != null && (
                            <span className="text-[#2451F3]">
                              {' '}(about {fmtUsd(report.seats.estUnusedUsd)} a month, estimate, for visibility, not billing)
                            </span>
                          )}
                        </>
                      )}
                    </span>
                  )}
                </div>
              )}
              <details className="text-[13px] text-[#8F8F8F]">
                <summary className="cursor-pointer select-none hover:text-[#4D4D4D] w-fit">
                  Why this differs from your Anthropic invoice
                </summary>
                <p className="m-0 mt-1.5 leading-5 max-w-2xl">
                  Code spend is estimated from token usage at published list rates. Actual Anthropic, Bedrock, or
                  Vertex billing may include volume discounts, credits, or different regional pricing. Cowork spend
                  reflects the actual per-request API cost recorded at the time. Neither figure includes non-Claude
                  usage, taxes, or account-level adjustments.
                </p>
              </details>
            </div>

            {dataQualityNotes.length > 0 && (
              <Notice tone="warn">
                {dataQualityNotes.map((note, i) => (
                  <span key={i} className="block">{note}</span>
                ))}
              </Notice>
            )}

            {/* By-surface strip */}
            {report.surfaces && <SurfaceTiles surfaces={report.surfaces} />}

            {/* Model efficiency — activity × model drill-down, directly below the by-surface strip. Self-gated on financeModelEfficiencyEnabled (route 404s when off, section hides). */}
            <ModelEfficiencySection period={period} />

            {/* Charts: spend trend / month-end projection / concentration */}
            <FinopsCharts
              trend={trend}
              monthToDate={report.monthToDate}
              projection={report.projection ?? null}
              costCentreTotals={report.costCentres.map(c => c.totalUsd)}
            />

            {/* Top spenders + this-month insight */}
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-4">
              <Leaderboard leaderboard={report.leaderboard ?? []} period={period} />
              <InsightCard insight={report.insight ?? null} dataQualityNotes={dataQualityNotes} />
            </div>

            {/* Cost centres, Unallocated last */}
            {centreKeys.length > 0 && (
              <Panel
                title="By cost centre"
                subtitle={`${centreCount} centre${centreCount === 1 ? '' : 's'}${report.unallocated.users.length > 0 ? ', plus unallocated' : ''}`}
                right={
                  <button
                    type="button"
                    className={B.link}
                    onClick={() => setOpenCentres(allOpen ? new Set() : new Set(centreKeys))}
                  >
                    {allOpen ? 'Hide people' : 'Show people'}
                  </button>
                }
                flush
              >
                <div className="overflow-x-auto">
                  <table className={T.table}>
                    <thead>
                      <tr className={T.headRow}>
                        <th scope="col" className={T.th}>Cost centre</th>
                        <th scope="col" className={T.th}>GL code</th>
                        <th scope="col" className={T.thRight}>People</th>
                        <th scope="col" className={T.th}>Share</th>
                        <th scope="col" className={T.thRight}>Spend</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.costCentres.map(centre => (
                        <CentreRow
                          key={centre.name}
                          name={centre.name}
                          code={centre.code}
                          totalUsd={centre.totalUsd}
                          users={centre.users}
                          grandTotalUsd={report.grandTotalUsd}
                          open={openCentres.has(`centre:${centre.name}`)}
                          onToggle={() => toggleCentre(`centre:${centre.name}`)}
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
                        />
                      )}
                    </tbody>
                  </table>
                </div>
              </Panel>
            )}
          </>
        )}
      </PageBody>
    </>
  );
}
