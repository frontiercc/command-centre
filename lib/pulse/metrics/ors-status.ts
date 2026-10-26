// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// ORS (Operational Resilience Score) interpretive status — pure + client-safe
// (no DB/IO) so the CIO exec card and the radar signals table render
// consistent copy from one source of truth. Mirrors the oti-status.ts pattern.
//
// A single 0.5 cutoff put a genuinely borderline score (e.g. an org-wide
// 0.48, or any department in the high 0.3s/low 0.4s) in the same "Concentrated
// — structural warning" bucket as a score near zero — alarming and
// misleading when dozens of people are actively using Cowork. This adds a
// softer "Early stage" band between "Developing resilience" and the
// genuinely-low "Concentrated" band, and rewords the low band to describe
// what's actually low (overlap/propagation of practice), not headcount —
// ORS can be low even with wide participation if what's learned isn't shared.

export type OrsLevel = 'not-measurable' | 'resilient' | 'developing' | 'early' | 'concentrated';

export interface OrsRead {
  level: OrsLevel;
  status: string;
  plain: string;
  statusColor: string;
  dotColor: string;
}

const RESILIENT_FLOOR = 0.7;
const DEVELOPING_FLOOR = 0.5;
const EARLY_FLOOR = 0.35;

/** Classify a raw ORS value into one of the five interpretive bands. */
export function orsLevel(ors: number | null): OrsLevel {
  if (ors === null) return 'not-measurable';
  if (ors >= RESILIENT_FLOOR) return 'resilient';
  if (ors >= DEVELOPING_FLOOR) return 'developing';
  if (ors >= EARLY_FLOOR) return 'early';
  return 'concentrated';
}

/** Full narrative read for the CIO exec signal card. */
export function readOrs(ors: number | null): OrsRead {
  const level = orsLevel(ors);
  switch (level) {
    case 'not-measurable':
      return {
        level,
        status: 'Not yet measurable',
        plain: 'Requires at least two active team members. Will appear once more than one person is using Cowork at meaningful depth.',
        statusColor: 'text-gray-400',
        dotColor: 'bg-gray-300',
      };
    case 'resilient':
      return {
        level,
        status: 'Resilient',
        plain: 'Capability belongs to the organisation, not one person. The team would sustain its AI capability through personnel change. This is what institutional transformation looks like.',
        statusColor: 'text-emerald-600',
        dotColor: 'bg-emerald-500',
      };
    case 'developing':
      return {
        level,
        status: 'Developing resilience',
        plain: 'Shared capability is building but not yet robust. A key person leaving would cause disruption. The priority is connector sharing and skill propagation across more team members.',
        statusColor: 'text-blue-500',
        dotColor: 'bg-blue-400',
      };
    case 'early':
      return {
        level,
        status: 'Early stage: spreading but shallow',
        plain: "Capability is starting to spread across the team, but overlap and hand-off of practice are still shallow. This is not yet a structural risk, but it isn't resilient either. The priority is broadening who shares connectors and propagates skills.",
        statusColor: 'text-amber-500',
        dotColor: 'bg-amber-400',
      };
    case 'concentrated':
      return {
        level,
        status: 'Concentrated: structural warning',
        plain: "Overlap and hand-off of practice across the team are low. This can happen even with broad participation, if what's learned isn't shared. Regardless of the other signals, the AI capability built here is fragile to personnel change today.",
        statusColor: 'text-red-500',
        dotColor: 'bg-red-400',
      };
  }
}

/** Short one-line comment for the radar signals breakdown table. */
export function orsRadarComment(ors: number | null): string {
  const level = orsLevel(ors);
  switch (level) {
    case 'not-measurable': return 'Needs 2+ active members';
    case 'resilient': return 'Capability belongs to the team, not one person';
    case 'developing': return 'Spreading, not yet robust';
    case 'early': return 'Early stage: spreading but shallow';
    case 'concentrated': return 'Low overlap/hand-off: structural warning';
  }
}
