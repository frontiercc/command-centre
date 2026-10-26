// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Developer Pulse "Time saved (bottom-up estimate)" — pure, deterministic, unit-tested.
 *
 * Unlike the top-down Value estimate (team × lift% × loaded comp, a benchmark
 * projection), this is a bottom-up rollup: measured output counts (PRs,
 * AI-assisted commits, Cowork sessions, Chat conversations) each multiplied
 * by an admin-editable minutes-per-task assumption. Both are estimates and
 * both are shown — this one grounds the story in per-artifact counts rather
 * than a headcount/lift formula.
 */

export interface TimeSavedAssumptions {
  minPerPr: number;
  minPerCommit: number;
  minPerCoworkSession: number;
  minPerChatConversation: number;
}

export const TIME_SAVED_DEFAULTS: TimeSavedAssumptions = {
  minPerPr: 150,
  minPerCommit: 20,
  minPerCoworkSession: 10,
  minPerChatConversation: 4,
};

export interface TimeSavedCounts {
  prCount: number;
  commitCount: number;
  coworkSessions: number;
  chatConversations: number;
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
  timeSavedMinPerCoworkSession: string;
  timeSavedMinPerChatConversation: string;
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
    minPerCoworkSession: resolveField(config.timeSavedMinPerCoworkSession, TIME_SAVED_DEFAULTS.minPerCoworkSession),
    minPerChatConversation: resolveField(config.timeSavedMinPerChatConversation, TIME_SAVED_DEFAULTS.minPerChatConversation),
  };
}

export function computeTimeSaved(counts: TimeSavedCounts, a: TimeSavedAssumptions): { totalHours: number; rows: TimeSavedRow[] } {
  const specs: Array<{ label: string; count: number; minutesEach: number }> = [
    { label: 'PRs', count: counts.prCount, minutesEach: a.minPerPr },
    { label: 'AI-assisted commits', count: counts.commitCount, minutesEach: a.minPerCommit },
    { label: 'Cowork sessions', count: counts.coworkSessions, minutesEach: a.minPerCoworkSession },
    { label: 'Chat conversations', count: counts.chatConversations, minutesEach: a.minPerChatConversation },
  ];

  const rows: TimeSavedRow[] = specs
    .filter(s => s.count > 0)
    .map(s => ({ label: s.label, count: s.count, minutesEach: s.minutesEach, hours: (s.count * s.minutesEach) / 60 }));

  const totalMinutes = specs.reduce((sum, s) => sum + s.count * s.minutesEach, 0);
  const totalHours = Math.round(totalMinutes / 60);

  return { totalHours, rows };
}
