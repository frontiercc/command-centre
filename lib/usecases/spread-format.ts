// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Spread Panel — pure text formatting helpers. ZERO imports so 'use client'
 * components (SpreadPanel) can use them without dragging the DB client into
 * the browser bundle (same leaf-module pattern as lib/pulse/code/model-id.ts).
 * Wording: humanised signal labels + honest
 * units — task-type counts are classified messages, invocation counts are
 * skill/connector uses.
 */

/** 'work': judged sessions of the use case's work. The older kinds remain only for stale payloads. */
export type SpreadSignalKind = 'task_type' | 'invocation' | 'work';

/** 'structured_report' → 'structured report' for prose; skill/connector names pass through. */
export function humaniseSignal(signal: string, kind: SpreadSignalKind): string {
  return kind === 'task_type' ? signal.replace(/_/g, ' ') : signal;
}

/** Unit phrase for an activity count — messages for task types, uses for invocations. */
export function activityPhrase(count: number, kind: SpreadSignalKind): string {
  if (kind === 'work') return `${count} session${count === 1 ? '' : 's'}`;
  return kind === 'task_type'
    ? `${count} matching message${count === 1 ? '' : 's'}`
    : `${count} use${count === 1 ? '' : 's'}`;
}

export interface MatchedSignalEvidence { signal: string; kind: SpreadSignalKind; count: number }

/** Full-evidence row line (agreed format): every matched signal,
 * not just the strongest — "structured report + claude-in-chrome · 14 in the
 * last 4 weeks" — so a row always explains why the person is listed. */
export function evidenceLine(signals: MatchedSignalEvidence[], windowWeeks: number): string {
  const work = signals.find(s => s.kind === 'work');
  if (work) return `did this work in ${activityPhrase(work.count, 'work')} in the last ${windowWeeks} weeks, without the skill`;
  const names = signals.map(s => humaniseSignal(s.signal, s.kind)).join(' + ');
  const total = signals.reduce((acc, s) => acc + s.count, 0);
  return `${names} · ${total} in the last ${windowWeeks} weeks`;
}
