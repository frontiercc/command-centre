// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Developer Pulse "Time saved (bottom-up estimate)" — pure, deterministic, unit-tested.
 *
 * Unlike the top-down Value estimate (team × lift% × loaded comp, a benchmark
 * projection), this is a bottom-up rollup: measured coding output counts (pull
 * requests and AI-assisted commits, from Claude Code and Codex) each multiplied
 * by an admin-editable minutes-per-task assumption. Both are estimates and
 * both are shown — this one grounds the story in per-artifact counts rather
 * than a headcount/lift formula.
 *
 * Coding work only: Claude Cowork and Claude Chat time saved belongs on Work
 * Pulse, which has its own human-time figures (the owner's rule, 2026-11-15).
 */

export interface TimeSavedAssumptions {
  minPerPr: number;
  minPerCommit: number;
}

export const TIME_SAVED_DEFAULTS: TimeSavedAssumptions = {
  minPerPr: 150,
  minPerCommit: 20,
};

export interface TimeSavedCounts {
  prCount: number;
  commitCount: number;
}

export interface TimeSavedRow {
  label: string;
  count: number;
  minutesEach: number;
  hours: number;
}

interface RawTimeSavedConfig {
  timeSavedMinPerPr: string;
  timeSavedMinPerCommit: string;
}

function resolveField(override: string, fallback: number): number {
  const t = override.trim();
  if (t !== '') {
    const v = parseFloat(t);
    if (!isNaN(v)) return v;
  }
  return fallback;
}

/** Resolve minutes-per-task assumptions from raw config strings, falling back to TIME_SAVED_DEFAULTS on blank/NaN. */
export function resolveTimeSavedAssumptions(config: RawTimeSavedConfig): TimeSavedAssumptions {
  return {
    minPerPr: resolveField(config.timeSavedMinPerPr, TIME_SAVED_DEFAULTS.minPerPr),
    minPerCommit: resolveField(config.timeSavedMinPerCommit, TIME_SAVED_DEFAULTS.minPerCommit),
  };
}

export function computeTimeSaved(counts: TimeSavedCounts, a: TimeSavedAssumptions): { totalHours: number; rows: TimeSavedRow[] } {
  const specs: Array<{ label: string; count: number; minutesEach: number }> = [
    { label: 'pull requests opened', count: counts.prCount, minutesEach: a.minPerPr },
    { label: 'AI-assisted commits', count: counts.commitCount, minutesEach: a.minPerCommit },
  ];

  const rows: TimeSavedRow[] = specs
    .filter(s => s.count > 0)
    .map(s => ({ label: s.label, count: s.count, minutesEach: s.minutesEach, hours: (s.count * s.minutesEach) / 60 }));

  const totalMinutes = specs.reduce((sum, s) => sum + s.count * s.minutesEach, 0);
  const totalHours = Math.round(totalMinutes / 60);

  return { totalHours, rows };
}
