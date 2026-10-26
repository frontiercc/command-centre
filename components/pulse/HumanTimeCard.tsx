// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Human time vs Claude time. Two figures side by side and
 * never blended: the by-hand figure is an AI ESTIMATE (violet), Claude time is
 * MEASURED active time (blue). Tier 2 and 3 sessions only, last 30 days.
 * Renders nothing when the feature is off or no session carries both figures.
 */
import { codeWorkTypeLabel } from '@/lib/pulse/code/work-type-labels';
import { Panel, Tag, Bar, SubHead } from '@/components/precision/ui';

export interface HumanTimeRow { kind: string; sessions: number; humanMinutes: number; claudeMinutes: number }
export interface HumanTimeSummary {
  windowDays: number;
  sessions: number;
  humanMinutes: { low: number; likely: number; high: number };
  claudeMinutes: number;
  ratio: number | null;
  byKind: HumanTimeRow[];
  /** Latest monthly spot-check (counts only); null = not yet checked. */
  check?: { period: string; reviewed: number; aboutRight: number } | null;
}

function hours(minutes: number): string {
  const h = minutes / 60;
  return h < 10 ? h.toFixed(1) : Math.round(h).toLocaleString();
}

function monthName(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function label(k: string, surface: 'code' | 'cowork'): string {
  if (surface === 'code') return codeWorkTypeLabel(k);
  return k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export default function HumanTimeCard({ summary, surface, scope, className = '' }: {
  summary: HumanTimeSummary | null | undefined;
  surface: 'code' | 'cowork';
  scope: string;
  /** Spacing lives on the card, so a hidden card leaves no gap. */
  className?: string;
}) {
  if (!summary || summary.sessions === 0) return null;
  // Cowork's active time includes the person working alongside Claude.
  const claudeLabel = surface === 'cowork' ? 'hours with Claude' : 'hours of Claude time';
  const { low, likely, high } = summary.humanMinutes;

  const maxKind = Math.max(1, ...summary.byKind.map(k => k.humanMinutes));
  const pct = (m: number) => Math.max(1, Math.round((m / maxKind) * 100));

  return (
    <Panel
      className={className}
      title="By hand vs with Claude"
      subtitle={scope}
      right={<><Tag tone="judged">Estimate</Tag><Tag tone="measured">Measured</Tag></>}
    >
      <div className={summary.byKind.length > 0 ? 'grid grid-cols-1 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-6' : ''}>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <div title={`Range ${hours(low)}–${hours(high)} hours`}>
              <p className="m-0 text-[24px] leading-7 font-semibold tabular-nums text-[#2451F3]">~{hours(likely)} h</p>
              <p className="m-0 mt-1 text-[13px] text-[#8F8F8F]">by hand (estimate)</p>
            </div>
            <div>
              <p className="m-0 text-[24px] leading-7 font-semibold tabular-nums text-[#05073F]">{hours(summary.claudeMinutes)} h</p>
              <p className="m-0 mt-1 text-[13px] text-[#8F8F8F]">{claudeLabel}</p>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Bar pct={100} tone="judged" height={6} />
            <Bar pct={Math.max(1, Math.round((summary.claudeMinutes / Math.max(1, likely)) * 100))} tone="measured" height={6} />
          </div>
          {summary.ratio !== null && (
            <p className="m-0 text-[14px] text-[#333333]">About {summary.ratio < 10 ? summary.ratio.toFixed(1) : Math.round(summary.ratio)}× faster</p>
          )}
          <p className="m-0 text-[13px] text-[#8F8F8F] leading-5">
            {summary.sessions.toLocaleString()} Tier 2 and 3 sessions over the last {summary.windowDays} days. The by-hand figure is an AI estimate per session
            (range {hours(low)}–{hours(high)} hours); Claude time is measured active time.{' '}
            {summary.check
              ? <>Spot-check: {summary.check.aboutRight} of {summary.check.reviewed} estimates judged about right in {monthName(summary.check.period)}.</>
              : <>The estimates have not yet been spot-checked.</>}
          </p>
        </div>

        {summary.byKind.length > 0 && (
          <div className="min-w-0">
            <SubHead>By kind of work, hours</SubHead>
            <div className="flex flex-col gap-3">
              {summary.byKind.map(k => (
                <div key={k.kind} className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between gap-3 text-[13px]">
                    <span className="text-[14px] text-[#0A0A0A]">{label(k.kind, surface)}</span>
                    <span className="shrink-0 tabular-nums text-[#8F8F8F]">
                      <span className="text-[#2451F3]">~{hours(k.humanMinutes)}</span> by hand ·{' '}
                      <span className="text-[#05073F]">{hours(k.claudeMinutes)}</span> with Claude · {k.sessions} sessions
                    </span>
                  </div>
                  <Bar pct={pct(k.humanMinutes)} tone="judged" height={4} />
                  <Bar pct={pct(k.claudeMinutes)} tone="measured" height={4} />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}
