// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Workflow Impact drill-in panel — the measured
// hours/friction/participation/depth view for one use case, plus the
// grounded AI-written summary. Mirrors this page's own local-type convention
// (no runtime import from lib/usecases/impact.ts — that module pulls in
// getTypedClient/drizzle-orm and must never enter this client bundle; see
// the identical note in SpreadPanel.tsx).
'use client';

import { useEffect, useState } from 'react';
import Sparkline from '@/components/pulse/Sparkline';
import { weekStart } from '@/lib/pulse/period';
import { Panel, PanelFoot, SubHead, Tag, B, Muted, cx } from '@/components/precision/ui';

interface ImpactWeek {
  weekStart: number;
  sessions: number | null;
  durationSecs: number | null;
  engagedSecs: number | null;
  toolErrors: number | null;
  coworkToolErrors?: number | null;
  editRejects: number | null;
  editAccepts: number | null;
  flagged: number | null;
}
interface ImpactParticipationItem { name: string; sessions: number }
interface ImpactDepthWeek { weekStart: number; tierCounts: Record<number, number>; total: number }
export interface UseCaseImpact {
  windowWeeks: number;
  weeks: ImpactWeek[];
  totals: {
    durationSecs: number | null; engagedSecs: number | null; sessions: number; estimateHours: number | null;
    coworkDurationSecs: number | null; codeDurationSecs: number | null;
  };
  participation: {
    skills: ImpactParticipationItem[];
    connectors: ImpactParticipationItem[];
    models: ImpactParticipationItem[];
    surfaces: { cowork: number; code: number };
    cappedAt: number | null;
  };
  depth: { weeks: ImpactDepthWeek[]; rubricChangesAt: number[] };
}
export interface ImpactSummary { text: string | null; generatedAt: number | null }

interface ImpactPanelProps {
  impact: UseCaseImpact;
  summary: ImpactSummary;
  useCaseId: string;
  canRegenerate: boolean;
}

const MEASURED_CLS = 'text-[#05073F]';
const ESTIMATE_CLS = 'text-[#2451F3]';
const BLOCK_CLS = 'px-4 py-3 border-t border-[#F2F2F2] first:border-t-0 flex flex-col gap-2';

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function hoursLabel(secs: number | null): string {
  return secs === null ? 'Not measured' : `${round1(secs / 3600).toFixed(1)}h`;
}

/** "(Cowork 2.1h · Code 1.1h)" — surface parts omitted individually when null; null when neither surface is measured. */
function surfaceSplitLabel(coworkSecs: number | null, codeSecs: number | null): string | null {
  const parts: string[] = [];
  if (coworkSecs !== null) parts.push(`Cowork ${round1(coworkSecs / 3600).toFixed(1)}h`);
  if (codeSecs !== null) parts.push(`Code ${round1(codeSecs / 3600).toFixed(1)}h`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** AI-judged tiers: light to deep violet. */
const TIER_CLS: Record<number, string> = { 1: 'bg-[#CCD1DB]', 2: 'bg-[#8DB2FC]', 3: 'bg-[#3D6CE8]' };

export default function ImpactPanel({ impact, summary, useCaseId, canRegenerate }: ImpactPanelProps) {
  const [localSummary, setLocalSummary] = useState(summary);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState(false);

  // Keep in sync with the parent (e.g. its own 7-day lazy background refresh).
  useEffect(() => setLocalSummary(summary), [summary]);

  const regenerate = async () => {
    setGenerating(true);
    setGenError(false);
    try {
      const res = await fetch(`/api/use-cases/${encodeURIComponent(useCaseId)}/impact-summary`, { method: 'POST' });
      if (!res.ok) { setGenError(true); return; }
      const data = await res.json();
      setLocalSummary({ text: data.summary, generatedAt: data.generatedAt });
    } catch {
      setGenError(true);
    } finally {
      setGenerating(false);
    }
  };

  const rubricWeekStarts = new Set(impact.depth.rubricChangesAt.map(ts => weekStart(ts)));
  const depthByWeek = new Map(impact.depth.weeks.map(w => [w.weekStart, w]));
  const split = surfaceSplitLabel(impact.totals.coworkDurationSecs, impact.totals.codeDurationSecs);

  return (
    <Panel title="Workflow impact" flush>
      {/* Summary block */}
      <div className={BLOCK_CLS}>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-medium text-[#666666]">Summary</span>
          {localSummary.text && <Tag tone="judged">AI-written summary</Tag>}
          {canRegenerate && (
            <button type="button" onClick={regenerate} disabled={generating} className={cx(B.accent, 'ml-auto')}>
              {generating ? 'Generating...' : localSummary.text ? 'Regenerate' : 'Generate'}
            </button>
          )}
        </div>
        {genError ? (
          <Muted>Summary unavailable.</Muted>
        ) : localSummary.text ? (
          <p className="m-0 text-[14px] leading-6 text-[#333333]">{localSummary.text}</p>
        ) : (
          <Muted>No summary yet.</Muted>
        )}
      </div>

      {/* Hours block */}
      <div className={BLOCK_CLS}>
        <SubHead right={<Tag tone="measured">Measured</Tag>}>Time in this workflow</SubHead>
        {impact.totals.durationSecs !== null ? (
          <p className="m-0">
            <span className={cx('text-[24px] leading-7 font-semibold tracking-[-0.02em] tabular-nums', MEASURED_CLS)}>
              {hoursLabel(impact.totals.durationSecs)}
            </span>
            <span className={cx('text-[14px] ml-1.5', MEASURED_CLS)}>
              measured active time{split && <> ({split})</>}
            </span>
          </p>
        ) : (
          <div>
            <p className="m-0 text-[24px] leading-7 font-semibold tracking-[-0.02em] text-[#8F8F8F]">{hoursLabel(null)}</p>
            <p className="m-0 text-[13px] text-[#666666]">measured active time</p>
            {impact.totals.estimateHours !== null && (
              <p className={cx('m-0 mt-2 text-[14px] font-medium', ESTIMATE_CLS)}>
                {round1(impact.totals.estimateHours).toFixed(1)}h estimate: sessions × configured minutes (no measured active time yet)
              </p>
            )}
          </div>
        )}
        <Sparkline
          data={impact.weeks.map(w => w.durationSecs)}
          label="Weekly session duration"
        />
        <p className="m-0 text-[13px] text-[#8F8F8F]">Active hours per week, last 13 weeks</p>
      </div>

      {/* Friction ("Where it hurts") block removed:
          raw counts with no error detail, no baseline and no rate invited
          conclusions the data can't support. The weekly friction columns are
          still collected — the view can return if a rate + trend ever makes
          it decision-grade. */}

      {/* AI footprint block */}
      <div className={BLOCK_CLS}>
        <SubHead right={<Tag tone="measured">Measured</Tag>}>AI footprint</SubHead>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <ParticipationColumn label="Skills" items={impact.participation.skills} />
          <ParticipationColumn label="Connectors" items={impact.participation.connectors} />
          <ParticipationColumn label="Models" items={impact.participation.models} />
        </div>
        <p className="m-0 text-[13px] text-[#666666] tabular-nums">
          Cowork {impact.participation.surfaces.cowork} session{impact.participation.surfaces.cowork === 1 ? '' : 's'} · Code {impact.participation.surfaces.code} session{impact.participation.surfaces.code === 1 ? '' : 's'}
        </p>
      </div>

      {/* Depth block */}
      <div className={BLOCK_CLS}>
        <SubHead right={<Tag tone="judged">AI-judged</Tag>}>Are they handing it bigger jobs?</SubHead>
        <div className="flex items-end gap-[2px]" style={{ height: 40 }} role="img" aria-label="Weekly tier mix">
          {impact.weeks.map(w => {
            const d = depthByWeek.get(w.weekStart);
            const isRubricBreak = rubricWeekStarts.has(w.weekStart);
            const inner = !d || d.total === 0 ? (
              <div className="w-full h-1 bg-[#F2F2F2] self-end rounded-full" title="no data" />
            ) : (
              <div className="w-full h-full flex flex-col justify-end" title={new Date(w.weekStart * 1000).toISOString().slice(0, 10)}>
                <div className={`${TIER_CLS[3]} rounded-t-[2px]`} style={{ height: `${((d.tierCounts[3] ?? 0) / d.total) * 100}%` }} />
                <div className={TIER_CLS[2]} style={{ height: `${((d.tierCounts[2] ?? 0) / d.total) * 100}%` }} />
                <div className={TIER_CLS[1]} style={{ height: `${((d.tierCounts[1] ?? 0) / d.total) * 100}%` }} />
              </div>
            );
            return (
              <div
                key={w.weekStart}
                className={`flex-1 h-full flex flex-col justify-end ${isRubricBreak ? 'border-l-2 border-dashed border-[#B3B3B3] pl-0.5' : ''}`}
                title={isRubricBreak ? 'Tier rubric changed. Bands either side are not comparable.' : undefined}
              >
                {inner}
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-4 text-[13px] text-[#4D4D4D]">
          <span className="flex items-center gap-1.5"><span className={`w-2.5 h-2.5 ${TIER_CLS[1]} rounded-full inline-block`} aria-hidden="true" /> Tier 1</span>
          <span className="flex items-center gap-1.5"><span className={`w-2.5 h-2.5 ${TIER_CLS[2]} rounded-full inline-block`} aria-hidden="true" /> Tier 2</span>
          <span className="flex items-center gap-1.5"><span className={`w-2.5 h-2.5 ${TIER_CLS[3]} rounded-full inline-block`} aria-hidden="true" /> Tier 3</span>
        </div>
        <p className="m-0 text-[13px] text-[#8F8F8F]">Cowork work is counted per message, Code per session.</p>
      </div>

      {impact.participation.cappedAt !== null && (
        <PanelFoot>
          Based on the most recent {impact.participation.cappedAt.toLocaleString()} sessions.
        </PanelFoot>
      )}
    </Panel>
  );
}

function ParticipationColumn({ label, items }: { label: string; items: ImpactParticipationItem[] }) {
  return (
    <div className="min-w-0 break-words">
      <p className="m-0 mb-1 text-[13px] font-medium text-[#0A0A0A]">{label}</p>
      {items.length === 0 ? (
        <Muted>Not measured</Muted>
      ) : (
        <ul className="m-0 p-0 list-none flex flex-col gap-1">
          {items.slice(0, 6).map(item => (
            <li key={item.name} className="flex items-center gap-2 h-5 min-w-0">
              <span className="text-[13px] text-[#4D4D4D] truncate flex-1 min-w-0" title={item.name}>{item.name}</span>
              <span className="text-[13px] text-[#8F8F8F] tabular-nums shrink-0">
                {item.sessions} session{item.sessions === 1 ? '' : 's'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
