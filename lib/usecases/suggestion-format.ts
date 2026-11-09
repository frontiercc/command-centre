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
export interface SuggestionProducts { claude: number; chatgpt: number; codex: number }

/** `chatgpt:` ids are ChatGPT, `codex:` ids Codex, every other id Claude (the OpenAI sync's prefixes). */
export function productsOfSessions(ids: string[]): SuggestionProducts {
  const out: SuggestionProducts = { claude: 0, chatgpt: 0, codex: 0 };
  for (const id of new Set(ids)) {
    if (id.startsWith('chatgpt:')) out.chatgpt += 1;
    else if (id.startsWith('codex:')) out.codex += 1;
    else out.claude += 1;
  }
  return out;
}

/** "Claude 3 sessions · ChatGPT 2 sessions": each product with sessions, Claude first. */
export function formatSuggestionProducts(p: SuggestionProducts): string {
  const n = (k: number) => `${k} session${k === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (p.claude > 0) parts.push(`Claude ${n(p.claude)}`);
  if (p.chatgpt > 0) parts.push(`ChatGPT ${n(p.chatgpt)}`);
  if (p.codex > 0) parts.push(`Codex ${n(p.codex)}`);
  return parts.join(' · ');
}
