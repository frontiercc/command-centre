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

/** Sessions behind a suggestion by product, read from the session ids it was found in. */
export interface SuggestionProducts { cowork: number; code: number; chatgpt: number; codex: number }

/**
 * `chatgpt:` ids are ChatGPT and `codex:` ids Codex (the OpenAI sync's
 * prefixes). Every other id is Claude's: Claude Code when it is in
 * `claudeCodeIds` (sessions with a code_session_stats row), otherwise Claude
 * Cowork, which covers Cowork, Claude Chat and Claude in Office and Google.
 */
export function productsOfSessions(ids: string[], claudeCodeIds: ReadonlySet<string> = new Set()): SuggestionProducts {
  const out: SuggestionProducts = { cowork: 0, code: 0, chatgpt: 0, codex: 0 };
  for (const id of new Set(ids)) {
    if (id.startsWith('chatgpt:')) out.chatgpt += 1;
    else if (id.startsWith('codex:')) out.codex += 1;
    else if (claudeCodeIds.has(id)) out.code += 1;
    else out.cowork += 1;
  }
  return out;
}

/** "Claude Cowork 3 sessions · Claude Code 1 session · ChatGPT 2 sessions": each product with sessions, Claude's first. */
export function formatSuggestionProducts(p: SuggestionProducts): string {
  const n = (k: number) => `${k} session${k === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (p.cowork > 0) parts.push(`Claude Cowork ${n(p.cowork)}`);
  if (p.code > 0) parts.push(`Claude Code ${n(p.code)}`);
  if (p.chatgpt > 0) parts.push(`ChatGPT ${n(p.chatgpt)}`);
  if (p.codex > 0) parts.push(`Codex ${n(p.codex)}`);
  return parts.join(' · ');
}
