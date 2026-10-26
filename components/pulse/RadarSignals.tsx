// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis,
  PolarRadiusAxis, ResponsiveContainer,
} from 'recharts';
import { orsRadarComment } from '@/lib/pulse/metrics/ors-status';
import { Panel, Bar, Dot, Muted, SubHead } from '@/components/precision/ui';

interface RadarSignalsProps {
  oti: number | null;
  dds: number | null;
  governanceScore: number | null;
  ors: number | null;
}

// ── Normalise each signal to 0–100 for the radar shape ──────────────────────
// Full score anchored to the deck's "above threshold" targets.
// OTI: 1.5 = significant. DDS: 2.0 = frontier moving. governanceScore/ORS: already 0–1.
function norm(value: number | null, max: number): number {
  if (value === null) return 0;
  return Math.round(Math.min(value / max, 1) * 100);
}

// ── Transformation shape diagnosis ──────────────────────────────────────────
function diagnose(nOti: number, nDds: number, nGovernance: number, nOrs: number) {
  const allAbove = nOti >= 50 && nDds >= 60 && nGovernance >= 50 && nOrs >= 50;
  const depthWithoutStructure = nOti >= 60 && nDds >= 60 && nGovernance < 40 && nOrs < 40;
  const governanceLed = nGovernance >= 60 && nDds >= 40 && nOrs < 60;

  if (allAbove) return {
    label: 'Balanced transformation',
    description: 'All signals above threshold. Frontier has moved, governance is active, capability is shared. Ready to scale.',
    color: '#1A7F37',
  };
  if (depthWithoutStructure) return {
    label: 'Acceleration without structure',
    description: 'Work is deeper and faster. Governance and resilience have not kept pace. Priority: governance and resilience.',
    color: '#DC8A00',
  };
  if (governanceLed) return {
    label: 'Governance-led transformation',
    description: 'Oversight is active. Depth is building. Next priority: resilience and team-wide capability sharing.',
    color: '#245BF3',
  };
  return {
    label: 'Early stage',
    description: 'Foundation building. Watch the delegation depth trend: week 4 is where the shape starts to form.',
    color: '#A3A3A3',
  };
}

export default function RadarSignals({ oti, dds, governanceScore, ors }: RadarSignalsProps) {
  const nOti = norm(oti, 1.5);
  const nDds = norm(dds, 2.0);
  const nGovernance = norm(governanceScore, 1.0);
  const nOrs = norm(ors, 1.0);

  const hasData = oti !== null || dds !== null || governanceScore !== null || ors !== null;
  // Transformation score = (output + depth + resilience + governance) / 4
  const score = hasData
    ? Math.round((nOti + nDds + nGovernance + nOrs) / 4)
    : null;

  const shape = diagnose(nOti, nDds, nGovernance, nOrs);

  const chartData = [
    { signal: 'Output quality', value: nOti, fullMark: 100 },
    { signal: 'Delegation depth', value: nDds, fullMark: 100 },
    { signal: 'Governance', value: nGovernance, fullMark: 100 },
    { signal: 'Resilience', value: nOrs, fullMark: 100 },
  ];

  const parts = [
    {
      key: 'oti', label: 'Output quality', raw: oti, norm: nOti,
      display: oti !== null ? `${oti.toFixed(2)}×` : '—',
      comment: oti === null ? 'Not yet measurable'
        : oti >= 1.5 ? 'Significant uplift above baseline'
        : oti >= 1.2 ? 'Meaningful progress above baseline'
        : oti >= 1.0 ? 'Marginal gains, the operating model is not yet changing'
        : 'Below baseline',
    },
    {
      key: 'dds', label: 'Delegation depth', raw: dds, norm: nDds,
      display: dds !== null ? dds.toFixed(2) : '—',
      comment: dds === null ? 'Not yet measurable'
        : dds >= 2.0 ? 'Operating at frontier depth'
        : dds >= 1.5 ? 'Depth building, the operating model is starting to change'
        : 'Surface use, the operating model is unchanged',
    },
    {
      key: 'gov', label: 'Governance', raw: governanceScore, norm: nGovernance,
      display: governanceScore !== null ? governanceScore.toFixed(2) : '—',
      comment: governanceScore === null ? 'Not yet measurable'
        : governanceScore >= 0.7 ? 'Strong governance: queue reviewed, alerts acknowledged'
        : governanceScore >= 0.5 ? 'Governance building, some gaps remain'
        : 'Governance gaps: review the queue and acknowledge alerts',
    },
    {
      key: 'ors', label: 'Resilience', raw: ors, norm: nOrs,
      display: ors !== null ? ors.toFixed(2) : '—',
      comment: orsRadarComment(ors),
    },
  ];

  return (
    <Panel
      title="Transformation radar"
      right={score !== null ? (
        <span className="flex items-baseline gap-1">
          <span className="text-[20px] font-semibold tabular-nums text-[#0A0A0A]">{score}</span>
          <span className="text-[13px] text-[#8F8F8F]">/ 100</span>
        </span>
      ) : undefined}
    >
      <div className="flex flex-col gap-1 mb-3">
        <Dot color={shape.color}><span className="text-[14px] font-medium" style={{ color: shape.color === '#A3A3A3' ? '#4D4D4D' : shape.color }}>{shape.label}</span></Dot>
        <p className="m-0 text-[13px] text-[#666666] leading-5">{shape.description}</p>
      </div>

      {!hasData ? (
        <Muted>No signal data yet. The radar appears once metrics are computed.</Muted>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-center">
          <ResponsiveContainer width="100%" height={220}>
            <RadarChart data={chartData} margin={{ top: 5, right: 24, bottom: 5, left: 24 }}>
              <PolarGrid stroke="#EAEAEA" />
              <PolarAngleAxis dataKey="signal" tick={{ fontSize: 12, fill: '#666666' }} />
              <PolarRadiusAxis angle={90} domain={[0, 100]} tick={false} axisLine={false} />
              <Radar name="Signals" dataKey="value" stroke="#05073F" fill="#05073F" fillOpacity={0.12} strokeWidth={1.5} dot={{ fill: '#05073F', r: 2.5 }} />
            </RadarChart>
          </ResponsiveContainer>
          <div className="flex flex-col gap-3">
            <SubHead>How the score of {score} is worked out</SubHead>
            {parts.map(s => (
              <div key={s.key} className="flex flex-col gap-1">
                <div className="flex items-baseline gap-2 text-[14px]">
                  <span className="text-[#0A0A0A]">{s.label}</span>
                  <span className="text-[13px] text-[#8F8F8F] tabular-nums">{s.display}</span>
                  <span className="ml-auto font-medium tabular-nums">{s.norm}</span>
                </div>
                <Bar pct={s.norm} tone={s.raw === null ? 'neutral' : 'measured'} height={4} />
                <span className="text-[13px] text-[#8F8F8F]">{s.comment}</span>
              </div>
            ))}
            <p className="m-0 pt-2 border-t border-[#F2F2F2] text-[13px] text-[#666666] tabular-nums">
              ({nOti} + {nDds} + {nGovernance} + {nOrs}) ÷ 4 = <span className="font-semibold text-[#0A0A0A]">{score}</span>
            </p>
          </div>
        </div>
      )}
    </Panel>
  );
}
