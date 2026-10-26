// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helper: format the measured evidence line for an AI-suggested use-case
 * draft (Register page suggestions tray). Kept separate from the page
 * component so the formatting is unit-testable without a DOM.
 */
export interface SuggestionDraftEvidenceLine {
  matchingRule: { skills: string[]; connectors: string[]; taskTypes: string[]; departments: string[] };
  evidence: { distinctUsers: number; sessionCount: number; departments: string[] };
}

/** A task type slug as words: "structured_report" → "Structured report". Skill and connector
 * names are left as they are, since those are their real names on the S&C Board. */
function taskTypeLabel(slug: string): string {
  const words = slug.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `{distinctUsers} users · {departments joined or —} · {[...skills,...connectors,...taskTypes].join(' + ')}` */
export function formatSuggestionEvidenceLine(draft: SuggestionDraftEvidenceLine): string {
  const userCount = draft.evidence.distinctUsers;
  const userLabel = `${userCount} user${userCount === 1 ? '' : 's'}`;
  const deptLabel = draft.evidence.departments.length > 0 ? draft.evidence.departments.join(', ') : '—';
  const signals = [
    ...draft.matchingRule.skills,
    ...draft.matchingRule.connectors,
    ...draft.matchingRule.taskTypes.map(taskTypeLabel),
  ].join(' + ');
  // A cross-department suggestion can carry no tools at all; no trailing "·".
  return signals ? `${userLabel} · ${deptLabel} · ${signals}` : `${userLabel} · ${deptLabel}`;
}
