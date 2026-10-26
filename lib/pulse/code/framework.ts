// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// lib/pulse/code/framework.ts
// Pure crosswalk: maps measured Developer Pulse signals onto DX Core 4 boxes.
// No IO, no LLM, no causation. Fit labels keep the measured/proxy/not-captured line honest.

export type FitLevel = 'measured' | 'proxy' | 'ai_specific' | 'not_captured';
export type SpaceDim = 'activity' | 'efficiency' | 'performance' | 'satisfaction' | 'communication';

export interface CodeSignals {
  spendUsd: number | null;
  autonomyRatio: number | null;
  commitCount: number | null;
  prCount: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  editAcceptCount: number | null;
  editRejectCount: number | null;
  frictionIndex: number | null;
  engagedHours: number | null;
  cacheHitRatio: number | null;
  hasWorkMix: boolean;
}

export interface CrosswalkCell {
  label: string;
  value: string | null;
  fit: FitLevel;
  space: SpaceDim | null;
  note?: string;
}

export interface FrameworkBox {
  dimension: 'speed' | 'quality' | 'effectiveness' | 'impact';
  title: string;
  subtitle: string;
  cells: CrosswalkCell[];
  externalNote: string;
}

// Engaged hours is null-not-zero — a code_metrics row can exist with BOTH
// active-time columns NULL (the OTel metrics stream isn't configured on this
// instance), and that must render "—", never fabricate "0". Only compute
// once at least one side is present.
export function computeEngagedHours(userS: number | null, cliS: number | null): number | null {
  if (userS == null && cliS == null) return null;
  return ((userS ?? 0) + (cliS ?? 0)) / 3600;
}

const num = (n: number | null, digits = 0): string | null =>
  n === null || Number.isNaN(n) ? null : n.toLocaleString('en-US', { maximumFractionDigits: digits });

const pct = (n: number | null): string | null =>
  n === null || Number.isNaN(n) ? null : `${Math.round(n * 100)}%`;

const usd = (n: number | null): string | null =>
  n === null || Number.isNaN(n) ? null : `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

function acceptanceRate(accept: number | null, reject: number | null): number | null {
  if (accept === null || reject === null) return null;
  if (accept + reject === 0) return null;
  return accept / (accept + reject);
}

export function buildCrosswalk(s: CodeSignals): FrameworkBox[] {
  const accRate = acceptanceRate(s.editAcceptCount, s.editRejectCount);

  return [
    {
      dimension: 'speed',
      title: 'Speed',
      subtitle: 'How fast is AI-assisted work moving?',
      externalNote:
        'Lead time and deployment frequency come from your CD pipeline. Connect DX to fill these.',
      cells: [
        { label: 'AI-assisted commits (7d)', value: num(s.commitCount), fit: 'proxy', space: 'activity',
          note: 'Count of commits made inside Claude sessions, not total delivery.' },
        { label: 'Merged PRs (7d)', value: num(s.prCount), fit: 'proxy', space: 'activity' },
        { label: 'Code output (lines ±)', value:
            s.linesAdded === null && s.linesRemoved === null ? null
              : `+${num(s.linesAdded) ?? '—'} / −${num(s.linesRemoved) ?? '—'}`,
          fit: 'proxy', space: 'activity', note: 'Volume, not a productivity verdict.' },
      ],
    },
    {
      dimension: 'quality',
      title: 'Quality',
      subtitle: 'Is the AI-assisted work landing cleanly?',
      externalNote:
        'Change-failure rate and time to restore come from your CI and incident tooling. Connect DX to fill these.',
      cells: [
        { label: 'Edit acceptance rate', value: pct(accRate), fit: 'proxy', space: 'performance',
          note: 'Trust signal, not a change-failure rate.' },
        { label: 'Friction index', value: pct(s.frictionIndex), fit: 'proxy', space: 'efficiency',
          note: 'Share of tool actions that failed: a coaching signal.' },
      ],
    },
    {
      dimension: 'effectiveness',
      title: 'Effectiveness',
      subtitle: 'Is the developer experience good?',
      externalNote:
        'The Developer Experience Index (DXI) is a survey signal Command Centre does not capture. Connect DX to fill this.',
      cells: [
        { label: 'Engaged AI time (hrs, 7d)', value: num(s.engagedHours), fit: 'proxy', space: 'efficiency' },
        { label: 'Cache efficiency', value: pct(s.cacheHitRatio), fit: 'ai_specific', space: 'efficiency',
          note: 'AI-specific cost efficiency, not a framework metric.' },
      ],
    },
    {
      dimension: 'impact',
      title: 'Impact',
      subtitle: 'Where is the effort going?',
      externalNote:
        'Business impact (% time on new capability vs maintenance) comes from your planning tooling. Connect DX to fill this.',
      cells: [
        s.hasWorkMix
          ? { label: 'AI-judged work mix', value: 'See Work Mix', fit: 'proxy', space: 'performance',
              note: 'Judged by Haiku: the one non-measured signal here.' }
          : { label: 'AI-judged work mix', value: null, fit: 'not_captured', space: 'performance',
              note: 'Session classifier is off. Enable it in Developer Pulse admin.' },
        { label: 'Claude spend (context)', value: usd(s.spendUsd), fit: 'ai_specific', space: 'efficiency',
          note: 'AI cost, shown for context, in no framework box.' },
      ],
    },
  ];
}
