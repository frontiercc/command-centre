// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * FinOps "charts A" row — spend trend, month-end projection, spend
 * concentration. Spend trend + concentration are pure presentational
 * wrappers around existing deterministic helpers (lib/finance/trend,
 * lib/pulse/code/concentration); the month-end projection is now computed
 * server-side (`lib/finance/finops-projection.ts`, an honest MTD run rate)
 * and passed straight through — no client-side recomputation.
 */
import { Panel, Tag, Bar, Muted, cx } from '@/components/precision/ui';
import { computeSpendConcentration } from '@/lib/pulse/code/concentration';
import type { SpendProjection } from '@/lib/pulse/code/projection';
import { MIN_PROJECTION_DAYS } from '@/lib/finance/finops-projection';

export interface SpendTrendPoint {
  period: string;
  usd: number | null;
}

export interface SpendTrend {
  series: SpendTrendPoint[];
  render: boolean;
}

const fmtUsd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const fmtPct = (n: number) => `${Math.round(n * 100)}%`;

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-09" → "Sep 2026"; anything else passes through. */
function periodLabel(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return y && m >= 1 && m <= 12 ? `${MONTH_SHORT[m - 1]} ${y}` : period;
}

/** "2026-09" → "S", for the axis under each bar. */
function periodInitial(period: string): string {
  const m = Number(period.split('-')[1]);
  return m >= 1 && m <= 12 ? MONTH_SHORT[m - 1].charAt(0) : '';
}

/**
 * One bar per month. A null month is an empty slot with a faint baseline, never a
 * zero bar: no recorded spend is not the same as zero spend. The latest month is
 * solid blue, earlier months lighter blue; all of it is measured spend.
 */
function MonthBars({ series }: { series: SpendTrendPoint[] }) {
  const max = Math.max(0, ...series.map(p => p.usd ?? 0));
  return (
    <div>
      <div className="flex items-end gap-1.5 h-[120px] border-b border-[#EAEAEA]" role="img" aria-label="Spend by month">
        {series.map((p, i) => {
          const last = i === series.length - 1;
          const h = p.usd === null || max <= 0 ? 0 : Math.max(1, Math.round((p.usd / max) * 100));
          return (
            <div key={p.period} className="flex-1 h-full flex flex-col justify-end" title={`${periodLabel(p.period)}: ${p.usd === null ? 'no data' : fmtUsd(p.usd)}`}>
              {p.usd === null
                ? <div className="h-1 rounded-full bg-[#F2F2F2]" />
                : <div className={cx('rounded-t-[2px]', last ? 'bg-[#05073F]' : 'bg-[#8C96BF]')} style={{ height: `${h}%` }} />}
            </div>
          );
        })}
      </div>
      <div className="flex gap-1.5 mt-1">
        {series.map(p => (
          <span key={p.period} className="flex-1 basis-0 text-center text-[11px] text-[#8F8F8F]">{periodInitial(p.period)}</span>
        ))}
      </div>
    </div>
  );
}

function SpendTrendCard({ trend }: { trend: SpendTrend | null }) {
  if (!trend || !trend.render) {
    return (
      <Panel title="Spend trend">
        <Muted>Not enough history yet. The trend appears once 3 or more months have recorded spend.</Muted>
      </Panel>
    );
  }
  const latest = trend.series[trend.series.length - 1];
  const first = trend.series[0];
  return (
    <Panel
      title="Spend trend"
      subtitle={`${periodLabel(first.period)} to ${periodLabel(latest.period)}`}
      right={<span className="text-[13px] text-[#666666] tabular-nums">{latest.usd != null ? fmtUsd(latest.usd) : '—'} <span className="text-[#8F8F8F]">this month</span></span>}
    >
      <MonthBars series={trend.series} />
    </Panel>
  );
}

function ProjectionCard({ monthToDate, projection }: { monthToDate: boolean; projection: SpendProjection | null }) {
  if (!monthToDate || !projection) {
    return (
      <Panel title="Month-end projection">
        <Muted>Only shown for the current, in-progress month.</Muted>
      </Panel>
    );
  }
  if (projection.daysElapsed < MIN_PROJECTION_DAYS) {
    return (
      <Panel title="Month-end projection" right={<Tag tone="judged">Estimate</Tag>}>
        <div className="flex flex-col gap-2">
          <span className="text-[14px] text-[#4D4D4D]">Too early in the month to project.</span>
          <span className="text-[13px] text-[#666666] tabular-nums">Day {projection.daysElapsed} of {projection.daysInMonth}</span>
          <Bar pct={(projection.daysElapsed / Math.max(1, projection.daysInMonth)) * 100} tone="measured" height={6} />
          <Muted>Shown from day {MIN_PROJECTION_DAYS}, once a run rate means something.</Muted>
        </div>
      </Panel>
    );
  }
  return (
    <Panel title="Month-end projection" right={<Tag tone="judged">Estimate</Tag>}>
      <div className="flex flex-col gap-2">
        <span className="text-[24px] leading-7 font-semibold tracking-[-0.02em] tabular-nums text-[#2451F3]">{fmtUsd(projection.projected)}</span>
        <span className="text-[13px] text-[#666666] tabular-nums">Day {projection.daysElapsed} of {projection.daysInMonth}</span>
        <Bar pct={(projection.daysElapsed / Math.max(1, projection.daysInMonth)) * 100} tone="measured" height={6} />
        <Muted>Run-rate estimate, extrapolated from month-to-date spend.</Muted>
      </div>
    </Panel>
  );
}

function ConcentrationCard({ costCentreTotals }: { costCentreTotals: number[] }) {
  const concentration = computeSpendConcentration(costCentreTotals);
  if (!concentration) return null;
  return (
    <Panel title="Spend concentration" subtitle="Share of total spend by top cost centres" flush>
      <div className="py-1">
        {concentration.tiers.map(t => (
          <div key={t.topN} className="px-4 py-2 flex flex-col gap-1 border-t border-[#F2F2F2] first:border-t-0">
            <div className="flex items-baseline gap-2 text-[14px]">
              <span className="text-[#0A0A0A]">Top {t.topN}</span>
              <span className="ml-auto text-[13px] text-[#666666] tabular-nums">{fmtPct(t.share)}</span>
            </div>
            <Bar pct={t.share * 100} tone="measured" />
          </div>
        ))}
      </div>
    </Panel>
  );
}

export default function FinopsCharts({
  trend,
  monthToDate,
  projection,
  costCentreTotals,
}: {
  trend: SpendTrend | null;
  monthToDate: boolean;
  projection: SpendProjection | null;
  costCentreTotals: number[];
}) {
  const concentration = computeSpendConcentration(costCentreTotals);
  return (
    <div className={cx('grid grid-cols-1 gap-4', concentration ? 'md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]' : 'md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]')}>
      <SpendTrendCard trend={trend} />
      <ProjectionCard monthToDate={monthToDate} projection={projection} />
      <ConcentrationCard costCentreTotals={costCentreTotals} />
    </div>
  );
}
