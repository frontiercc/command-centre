// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Use Case detail — Activate card evidence line, pure text formatting. ZERO
 * imports so the 'use client' detail page can use it without dragging the DB
 * client into the browser bundle (same leaf-module pattern as
 * lib/usecases/spread-format.ts).
 *
 * The keyword-match count and the last-seen
 * date used to render inside ONE paragraph gated on `keywords.length > 0` —
 * a connector/task-type-only rule lost the last-seen date entirely, not just
 * the (rightly) keyword-gated count. The two facts are independent: last
 * seen comes from the activate evidence regardless of rule shape; the count
 * only means anything for a keyword rule.
 */

export interface ActivateEvidenceCounts {
  matchedMessages: number;
  windowDays: number;
  lastSeenAt: number | null;
}

/**
 * The "N prompts in those sessions · last seen ..." line under the activity
 * box. Activity is judged sessions, not keyword
 * hits, so the count is the prompts in the matching sessions. Returns null
 * when there is nothing to say.
 */
export function buildActivateEvidenceLine(evidence: ActivateEvidenceCounts): string | null {
  const countPart = evidence.matchedMessages > 0
    ? `${evidence.matchedMessages} prompt${evidence.matchedMessages === 1 ? '' : 's'} in those sessions over the last ${evidence.windowDays} days`
    : null;
  const lastSeenPart =
    evidence.lastSeenAt != null
      ? `last seen ${new Date(evidence.lastSeenAt * 1000).toLocaleDateString('en-GB')}`
      : null;
  const parts = [countPart, lastSeenPart].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(' · ') : null;
}

// Plain-English legend matching the delegation-depth bands used elsewhere
// (e.g. components/pulse/DelegationBands.tsx's Tier 1/Tier 3 captions) — the
// raw tier number alone ("tier 2") means nothing to a workflow-owner reader
// without the words.
const TIER_LABELS: Record<number, string> = {
  1: 'quick questions',
  2: 'defined tasks',
  3: 'delegated work',
};

/** "typical depth: defined tasks (tier 2)" — falls back to a bare tier number for an out-of-range tier. */
export function tierDepthLabel(tier: number): string {
  const label = TIER_LABELS[tier];
  return label ? `typical depth: ${label} (tier ${tier})` : `typical depth: tier ${tier}`;
}

// Raw matching-rule signal keys (lib/usecases/match.ts's `signals` set) ->
// human words. Underscore-free, no jargon.
const SIGNAL_LABELS: Record<string, string> = {
  work: 'the work itself (judged by reading the session)',
  skill: 'running its own skill',
  keywords: 'keywords',
  skills: 'skills',
  connectors: 'connectors',
  task_types: 'task types',
};

/**
 * Humanises the raw `evidence.signals` array ('task_types' -> 'task types')
 * and joins it as plain English ("connectors and task types", "keywords,
 * skills and task types"). An unrecognised signal name passes through
 * unchanged rather than disappearing. Empty input -> ''.
 */
export function humaniseMatchedSignals(signals: string[]): string {
  const labels = signals.map(s => SIGNAL_LABELS[s] ?? s);
  if (labels.length <= 1) return labels[0] ?? '';
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
