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
  /** All view: each product's own totals (Claude Cowork and ChatGPT). */
  byProduct?: { claude: { sessions: number; humanMinutes: number; claudeMinutes: number }; openai: { sessions: number; humanMinutes: number; claudeMinutes: number } };
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

export default function HumanTimeCard({ summary, surface, scope, className = '', view = 'claude' }: {
  summary: HumanTimeSummary | null | undefined;
  surface: 'code' | 'cowork';
  scope: string;
  /** Spacing lives on the card, so a hidden card leaves no gap. */
  className?: string;
  /**
   * The page's Claude / OpenAI switch, 'claude' on a hub with only Claude.
   * Names the measured side: Claude, ChatGPT (Work Pulse), Codex (Developer
   * Pulse), or AI when both products are counted.
   */
  view?: 'all' | 'claude' | 'openai';
}) {
  if (!summary || summary.sessions === 0) return null;
  const name = view === 'openai'
    ? (surface === 'cowork' ? 'ChatGPT' : 'Codex')
    : view === 'all' && (surface === 'code' || summary.byProduct) ? 'AI' : 'Claude';
  // Cowork's active time includes the person working alongside the assistant.
  const claudeLabel = surface === 'cowork' ? `hours with ${name}` : `hours of ${name} time`;
  const subtitle = surface === 'cowork'
    ? `${name === 'AI' ? 'Claude Cowork and ChatGPT' : name === 'ChatGPT' ? 'ChatGPT' : 'Claude Cowork'} · ${scope}`
    : scope;
  const bp = summary.byProduct;
  const { low, likely, high } = summary.humanMinutes;

  const maxKind = Math.max(1, ...summary.byKind.map(k => k.humanMinutes));
  const pct = (m: number) => Math.max(1, Math.round((m / maxKind) * 100));

  return (
    <Panel
      className={className}
      title={`By hand vs with ${name}`}
      subtitle={subtitle}
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
          {bp && (
            <p className="m-0 text-[13px] text-[#8F8F8F] tabular-nums">
              Claude Cowork ~{hours(bp.claude.humanMinutes)} h by hand, {hours(bp.claude.claudeMinutes)} h measured · ChatGPT ~{hours(bp.openai.humanMinutes)} h by hand, {hours(bp.openai.claudeMinutes)} h measured
            </p>
          )}
          <div className="flex flex-col gap-1">
            <Bar pct={100} tone="judged" height={6} />
            <Bar pct={Math.max(1, Math.round((summary.claudeMinutes / Math.max(1, likely)) * 100))} tone="measured" height={6} />
          </div>
          {summary.ratio !== null && (
            <p className="m-0 text-[14px] text-[#333333]">About {summary.ratio < 10 ? summary.ratio.toFixed(1) : Math.round(summary.ratio)}× faster</p>
          )}
          <p className="m-0 text-[13px] text-[#8F8F8F] leading-5">
            {summary.sessions.toLocaleString()} Tier 2 and 3 sessions over the last {summary.windowDays} days. The by-hand figure is an AI estimate per session
            (range {hours(low)}–{hours(high)} hours); {name} time is measured active time{surface === 'cowork' && name !== 'Claude' ? ', for ChatGPT from the times of its prompts and replies' : ''}.{' '}
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
                      <span className="text-[#05073F]">{hours(k.claudeMinutes)}</span> with {name} · {k.sessions} sessions
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
