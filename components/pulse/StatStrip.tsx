// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import type { ReactNode } from 'react';
import { otiStatus, DEFAULT_OTI_THRESHOLDS, type OtiStatus } from '@/lib/pulse/metrics/oti-status';
import { Strip, Figure, Tag, type Tone } from '@/components/precision/ui';

type Format = 'multiplier' | 'score' | 'percent' | 'count';

interface Signal {
  label: string;
  fullName: string;
  sublabel: string;
  formulaHint: string;
  value: number | null;
  delta?: number | null;
  format?: Format;
  pending?: string;
  /** OTI v2: baseline still forming — show the "Early read" badge. */
  earlyRead?: boolean;
  /** OTI v2: interpretive status line. */
  status?: OtiStatus | null;
  /** Violet when the figure rests on AI-judged tiers. */
  tone: Tone;
}

const STATUS_TONE: Record<OtiStatus['tone'], string> = {
  positive: 'text-[#1A7F37]',
  neutral: 'text-[#666666]',
  watch: 'text-[#B54708]',
};

function formatValue(value: number, format: Format = 'score'): string {
  if (format === 'multiplier') return `${value.toFixed(2)}×`;
  if (format === 'percent') return `${Math.round(value * 100)}%`;
  if (format === 'count') return String(Math.round(value));
  return value.toFixed(2);
}

/** Same wording and thresholds as DeltaBadge, in the kit's delta line. */
function deltaLine(delta: number, format: Format = 'score'): { text: string; tone?: Tone } {
  const abs = Math.abs(delta);
  const formatted = format === 'multiplier' ? `${abs.toFixed(2)}×`
    : format === 'percent' ? `${Math.round(abs * 100)}%`
    : format === 'count' ? String(Math.round(abs))
    : abs.toFixed(2);
  if (delta > 0.005) return { text: `↑ ${formatted} vs last period`, tone: 'good' };
  if (delta < -0.005) return { text: `↓ ${formatted} vs last period`, tone: 'bad' };
  return { text: 'No change' };
}

function toFigure(signal: Signal) {
  const isPending = signal.value === null;
  const label: ReactNode = (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      <span>{signal.fullName}</span>
      {signal.earlyRead && (
        <span title="This number is still settling. It finalises once you've run 30 classified tasks.">
          <Tag tone="warn">Early read</Tag>
        </span>
      )}
    </span>
  );
  const value: ReactNode = isPending
    ? <span className="text-[15px] font-medium text-[#8F8F8F] tracking-normal">{signal.pending ?? 'Pending baseline'}</span>
    : formatValue(signal.value as number, signal.format);

  let delta: ReactNode = null;
  let dTone: Tone | undefined;
  if (signal.earlyRead) {
    delta = 'Early read, settles after 30 tasks';
    dTone = 'warn';
  } else if (signal.delta !== undefined && signal.delta !== null) {
    const d = deltaLine(signal.delta, signal.format);
    delta = d.text;
    dTone = d.tone;
  }

  const sub: ReactNode = (
    <>
      <span className="block">{signal.sublabel}</span>
      {!signal.earlyRead && signal.status && (
        <span className={`block font-medium ${STATUS_TONE[signal.status.tone]}`}>{signal.status.label}</span>
      )}
      {!signal.earlyRead && (signal.delta === undefined || signal.delta === null) && (
        <span className="block text-[#8F8F8F]">{signal.formulaHint}</span>
      )}
    </>
  );

  return (
    <Figure
      key={signal.label}
      label={label}
      value={value}
      tone={isPending ? 'neutral' : signal.tone}
      delta={delta}
      deltaTone={dTone}
      sub={sub}
    />
  );
}

interface StatStripProps {
  oti: number | null;
  dds: number | null;
  psr: number | null;
  ors: number | null;
  // Optional prior-period deltas
  otiDelta?: number | null;
  ddsDelta?: number | null;
  psrDelta?: number | null;
  orsDelta?: number | null;
  // Set true on personal views — hides ORS (a team metric, not individual)
  hideOrs?: boolean;
  // OTI v2: baseline still forming (< 30 classified tasks).
  otiEarlyRead?: boolean;
  // OTI v2: classifier audit hasn't cleared its floor → hold the status verdict.
  otiUnderReview?: boolean;
}

export default function StatStrip({ oti, dds, psr, ors, otiDelta, ddsDelta, psrDelta, orsDelta, hideOrs, otiEarlyRead, otiUnderReview }: StatStripProps) {
  const showDeltas = otiDelta !== undefined || ddsDelta !== undefined || psrDelta !== undefined || orsDelta !== undefined;

  const signals: Signal[] = [
    {
      label: 'OTI',
      fullName: 'More valuable work',
      // OTI is a personal trajectory signal, NOT a cross-person governance
      // measure. It tracks each person against their own start; DDS is the
      // absolute depth measure.
      sublabel: 'Your delegation trajectory vs your own start',
      formulaHint: 'Median daily output now vs your baseline',
      value: oti,
      format: 'multiplier',
      pending: 'Pending data',
      earlyRead: otiEarlyRead,
      tone: 'judged',
      // Interpretive status (provisional thresholds).
      status: otiStatus(oti, dds, DEFAULT_OTI_THRESHOLDS, { earlyRead: otiEarlyRead, underReview: otiUnderReview }),
      // During early read the value is still settling; suppress the delta so we
      // don't imply a firm week-over-week move off a forming baseline.
      ...(showDeltas && !otiEarlyRead ? { delta: otiDelta ?? null } : {}),
    },
    {
      label: 'DDS',
      fullName: 'Delegation depth',
      sublabel: 'How deeply you delegate',
      formulaHint: 'Weighted avg tier over 14 days',
      value: dds,
      format: 'score',
      pending: 'Pending data',
      tone: 'judged',
      ...(showDeltas ? { delta: ddsDelta ?? null } : {}),
    },
    {
      label: 'Capabilities',
      fullName: 'New process automations',
      sublabel: 'Workflows Claude now handles end-to-end',
      formulaHint: 'Confirmed capability creation events',
      value: psr,
      format: 'count',
      pending: 'None confirmed yet',
      tone: 'neutral',
      ...(showDeltas ? { delta: psrDelta ?? null } : {}),
    },
    {
      label: 'ORS',
      fullName: 'Resilience',
      sublabel: 'Capability shared with the team',
      formulaHint: 'Breadth 30% · Connectors 40% · Skills 30%',
      value: ors,
      format: 'score',
      pending: 'Pending data',
      tone: 'neutral',
      ...(showDeltas ? { delta: orsDelta ?? null } : {}),
    },
  ];

  const visibleSignals = hideOrs ? signals.filter(s => s.label !== 'ORS') : signals;

  return (
    <Strip cols={visibleSignals.length === 3 ? 3 : 4}>
      {visibleSignals.map(toFigure)}
    </Strip>
  );
}
