// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// app/pulse/code/value/page.tsx
'use client';

import { useEffect, useState } from 'react';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { formatCurrency, FigureGrid } from '@/components/pulse/code/CodeStatStrip';
import { PageBody, Panel, PanelFoot, Figure, Tag, Notice, Empty, Muted } from '@/components/precision/ui';

interface ResolvedField { value: number; provenance: 'from_data' | 'default' | 'edited'; }
interface ObservedLift { liftPct: number; highWeeks: number; lowWeeks: number }
interface TimeSavedRow { label: string; count: number; minutesEach: number; hours: number; windowDays: number | null }
interface TimeSaved { totalHours: number; rows: TimeSavedRow[] }
interface ValueData {
  enabled: boolean;
  calibrations?: { teamSize: ResolvedField; liftPct: ResolvedField; loadedComp: ResolvedField; codingHrs: ResolvedField; annualSpend: ResolvedField };
  estimate?: { hasData: boolean; valueAnnual: number; timeRecoveredHours: number; netValue: number; returnMultiple: number | null };
  measured?: { spend30d: number; annualSpend: number; activeUsers: number; commitCount: number; prCount: number; sessionCount: number; engagedHours: number; costPerCommit: number | null; costPerPr: number | null; costPerSession: number | null; costPerEngagedHour: number | null; metricsWindowDays: number | null };
  observedLift?: ObservedLift | null;
  timeSaved?: TimeSaved | null;
}

const PROV_LABEL: Record<ResolvedField['provenance'], string> = { from_data: 'from your data', default: 'default', edited: 'edited' };

function fmtHours(h: number) { return `${Math.round(h).toLocaleString()} hrs`; }

export default function CodeValuePage() {
  const [data, setData] = useState<ValueData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showFormula, setShowFormula] = useState(false);

  useEffect(() => {
    fetch('/api/pulse/code/value')
      .then(async r => { if (!r.ok) throw new Error((await r.json()).error || "Couldn't load this page. Try again."); return r.json(); })
      .then(setData).catch(e => setError(e.message)).finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSpinner />;

  const e = data?.estimate;
  const me = data?.measured;
  const cal = data?.calibrations;
  const hasData = !!e?.hasData && !!me;

  const heroCells = [
    { label: 'Value (annual)', value: e ? formatCurrency(e.valueAnnual) : '—' },
    { label: 'Return', value: e?.returnMultiple != null ? `${e.returnMultiple.toFixed(0)}×` : '—' },
    { label: 'Net value', value: e ? formatCurrency(e.netValue) : '—' },
    { label: 'Time recovered', value: e ? fmtHours(e.timeRecoveredHours) : '—' },
  ];

  return (
    <>
      <TopBar title="Developer Pulse: Value" subtitle="An estimate of value created: benchmark-based, anchored to measured usage" />
      <PageBody>
        {error ? (
          <Notice tone="error">{error}</Notice>
        ) : data && !data.enabled ? (
          <Empty title="The Value view is turned off">An administrator can enable it in Admin → Developer Pulse → Value.</Empty>
        ) : !hasData ? (
          <Panel title="Value" right={<Tag tone="judged">Estimate</Tag>}>
            <Muted>Not enough data yet. Value and ROI appear once your team has more measured Claude Code usage.</Muted>
          </Panel>
        ) : (
          <>
            {/* Estimate hero — violet */}
            <Panel title="Industry benchmark model" subtitle="Annualised" right={<Tag tone="judged">Estimate</Tag>} flush>
              <div className="px-4 pt-3">
                <Muted>The planning estimate before your own data exists. As measured usage accrues, the blue measured numbers below progressively replace it.</Muted>
              </div>
              <FigureGrid cols={4}>
                {heroCells.map(c => <Figure key={c.label} label={c.label} value={c.value} tone="judged" />)}
              </FigureGrid>
              <div className="px-4 py-2.5 border-t border-[#F2F2F2]">
                <button
                  type="button"
                  onClick={() => setShowFormula(s => !s)}
                  aria-expanded={showFormula}
                  className="text-[13px] font-medium text-[#2451F3] hover:underline"
                >
                  How this is calculated {showFormula ? '▾' : '▸'}
                </button>
                {showFormula && cal && (
                  <p className="m-0 mt-2 text-[13px] leading-[1.6] text-[#666666]">
                    Value = team size ({cal.teamSize.value}) × productivity lift ({cal.liftPct.value}%) × loaded comp ({formatCurrency(cal.loadedComp.value)}).
                    Recovered coding hours are valued at full loaded compensation spread over coding hours only (the aggressive end of the estimate), so the figure
                    scales with headcount and the benchmark lift, not with the coding-hours input. Productivity lift is an industry benchmark; adjust it to your own
                    measurement in Admin → Developer Pulse → Value. Spend excludes unpriced models.
                  </p>
                )}
              </div>
            </Panel>

            {/* Time Saved (bottom-up estimate) — violet, a second method sitting beside the top-down one */}
            {data?.timeSaved != null && (
              <Panel title="Time saved" right={<Tag tone="judged">Estimate</Tag>} flush>
                <div className="p-4 flex flex-col gap-1.5">
                  <span className="text-[24px] leading-7 font-semibold tracking-[-0.02em] tabular-nums text-[#2451F3]">
                    ~{data.timeSaved.totalHours.toLocaleString()} hours
                  </span>
                  <span className="text-[13px] text-[#8F8F8F]">from measured output over the windows shown</span>
                </div>
                <ul className="m-0 p-0 list-none">
                  {data.timeSaved.rows.map(r => (
                    <li key={r.label} className="px-4 py-2 border-t border-[#F2F2F2] text-[14px] text-[#4D4D4D] tabular-nums">
                      {r.count.toLocaleString()} {r.label} × {r.minutesEach} min{r.windowDays != null ? ` · last ${r.windowDays}d` : ''}
                    </li>
                  ))}
                </ul>
                <PanelFoot>
                  Measured output counts × your minutes-per-task assumptions. Assumptions are editable in Admin → Developer Pulse → Value.
                </PanelFoot>
              </Panel>
            )}

            {/* Observed signal (beta) — violet, correlation only, shown beside (never mixed into) the benchmark headline */}
            {data?.observedLift != null && (
              <Panel title="Observed signal" right={<Tag tone="judged">Beta</Tag>}>
                <div className="flex flex-col gap-2">
                  <p className="m-0 text-[20px] leading-7 font-semibold tabular-nums text-[#2451F3]">
                    {data.observedLift.liftPct >= 0 ? '+' : ''}{Math.round(data.observedLift.liftPct * 100)}% output rate in higher-AI weeks
                  </p>
                  <p className="m-0 text-[13px] leading-[1.6] text-[#666666]">
                    Comparing AI-assisted commits/week across the {data.observedLift.highWeeks} highest vs {data.observedLift.lowWeeks} lowest AI-engaged-time weeks of the last 8 completed weeks, org-wide.
                    This is a <span className="font-semibold">correlation, not causation</span>: shown separately from the benchmark estimate above, never mixed into it.
                  </p>
                </div>
              </Panel>
            )}

            {/* Measured anchor — blue */}
            <Panel title="Measured, not estimated" right={<Tag tone="measured">Measured</Tag>} flush>
              <div className="px-4 pt-3">
                <Muted>The hard numbers behind the estimate. Spend is a 30-day priced total{me!.metricsWindowDays ? `; productivity over the latest ${me!.metricsWindowDays}-day window` : ''}.</Muted>
              </div>
              <FigureGrid cols={5}>
                {[
                  { label: 'Spend · 30 days', value: formatCurrency(me!.spend30d) },
                  { label: 'Active Code users', value: String(me!.activeUsers) },
                  { label: 'Commits', value: String(me!.commitCount) },
                  { label: 'PRs', value: String(me!.prCount) },
                  { label: 'Engaged hours', value: fmtHours(me!.engagedHours) },
                ].map(c => <Figure key={c.label} label={c.label} value={c.value} tone="measured" />)}
              </FigureGrid>
            </Panel>

            {/* §5c: Unit economics — the language finance speaks, fully measured (blue). */}
            <Panel title="Unit economics" right={<Tag tone="measured">Measured</Tag>} flush>
              <div className="px-4 pt-3">
                <Muted>What each unit of shipped work costs in Claude Code spend{me!.metricsWindowDays ? `, over the latest ${me!.metricsWindowDays}-day window` : ''}.</Muted>
              </div>
              <FigureGrid cols={4}>
                {[
                  { label: 'Cost per commit', value: me!.costPerCommit == null ? '—' : formatCurrency(me!.costPerCommit) },
                  { label: 'Cost per PR', value: me!.costPerPr == null ? '—' : formatCurrency(me!.costPerPr) },
                  { label: 'Spend per engaged hour', value: me!.costPerEngagedHour == null ? '—' : formatCurrency(me!.costPerEngagedHour) },
                  { label: 'Cost per session', value: me!.costPerSession == null ? '—' : formatCurrency(me!.costPerSession) },
                ].map(c => <Figure key={c.label} label={c.label} value={c.value} tone="measured" />)}
              </FigureGrid>
            </Panel>

            {/* Calibrations — read-only */}
            {cal && (
              <Panel title="Calibrations" subtitle="Set by an administrator in Admin → Developer Pulse → Value" flush>
                <FigureGrid cols={5}>
                  {[
                    { label: 'Team size', f: cal.teamSize, fmt: (v: number) => String(v) },
                    { label: 'Productivity lift', f: cal.liftPct, fmt: (v: number) => `${v}%` },
                    { label: 'Loaded comp', f: cal.loadedComp, fmt: (v: number) => formatCurrency(v) },
                    { label: 'Coding hrs / week', f: cal.codingHrs, fmt: (v: number) => String(v) },
                    { label: 'Annual spend', f: cal.annualSpend, fmt: (v: number) => formatCurrency(v) },
                  ].map(c => (
                    <Figure key={c.label} label={c.label} value={c.fmt(c.f.value)} sub={PROV_LABEL[c.f.provenance]} />
                  ))}
                </FigureGrid>
              </Panel>
            )}
          </>
        )}
      </PageBody>
    </>
  );
}
