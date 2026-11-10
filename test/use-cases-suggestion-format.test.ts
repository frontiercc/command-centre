// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { formatSuggestionEvidenceLine, productsOfSessions, formatSuggestionProducts } from '@/lib/usecases/suggestion-format';

describe('formatSuggestionEvidenceLine', () => {
  it('joins users, departments and signals with the expected separators', () => {
    const line = formatSuggestionEvidenceLine({
      matchingRule: { skills: ['contract-review'], connectors: ['docusign'], taskTypes: ['summarization'], departments: ['Legal'] },
      evidence: { distinctUsers: 4, sessionCount: 9, departments: ['Legal'] },
    });
    expect(line).toBe('4 users · Legal · contract-review + docusign + Summarization');
  });

  it('uses singular "user" for a count of 1', () => {
    const line = formatSuggestionEvidenceLine({
      matchingRule: { skills: ['seed-library'], connectors: [], taskTypes: [], departments: [] },
      evidence: { distinctUsers: 1, sessionCount: 1, departments: [] },
    });
    expect(line).toBe('1 user · — · seed-library');
  });

  it('falls back to an em dash when no departments are present', () => {
    const line = formatSuggestionEvidenceLine({
      matchingRule: { skills: [], connectors: ['slack'], taskTypes: [], departments: [] },
      evidence: { distinctUsers: 3, sessionCount: 5, departments: [] },
    });
    expect(line).toBe('3 users · — · slack');
  });

  it('joins multiple departments with a comma', () => {
    const line = formatSuggestionEvidenceLine({
      matchingRule: { skills: [], connectors: [], taskTypes: ['legal_review'], departments: ['Legal', 'Finance'] },
      evidence: { distinctUsers: 2, sessionCount: 2, departments: ['Legal', 'Finance'] },
    });
    expect(line).toBe('2 users · Legal, Finance · Legal review');
  });

  it('concatenates skills, connectors and task types in that order', () => {
    const line = formatSuggestionEvidenceLine({
      matchingRule: { skills: ['a'], connectors: ['b'], taskTypes: ['c'], departments: [] },
      evidence: { distinctUsers: 2, sessionCount: 2, departments: [] },
    });
    expect(line).toBe('2 users · — · a + b + C');
  });

  it('leaves off the tools segment when a suggestion has none', () => {
    const line = formatSuggestionEvidenceLine({
      matchingRule: { skills: [], connectors: [], taskTypes: [], departments: ['Sales', 'Consulting'] },
      evidence: { distinctUsers: 3, sessionCount: 5, departments: ['Sales', 'Consulting'] },
    });
    expect(line).toBe('3 users · Sales, Consulting');
  });
});

describe('suggestion sessions by product', () => {
  it('reads the product from each session id, counting a repeated id once', () => {
    expect(productsOfSessions(['chatgpt:a', 'ff-cw-1', 'codex:b', 'chatgpt:a', 'ff-code-2'], new Set(['ff-code-2'])))
      .toEqual({ cowork: 1, code: 1, chatgpt: 1, codex: 1 });
    // Without the Claude Code ids, every Claude session counts as Claude Cowork.
    expect(productsOfSessions(['ff-cw-1', 'ff-code-2'])).toEqual({ cowork: 2, code: 0, chatgpt: 0, codex: 0 });
  });
  it('names each product with sessions, Claude first, and leaves out a product with none', () => {
    expect(formatSuggestionProducts({ cowork: 3, code: 0, chatgpt: 2, codex: 0 })).toBe('Claude Cowork 3 sessions · ChatGPT 2 sessions');
    expect(formatSuggestionProducts({ cowork: 0, code: 0, chatgpt: 1, codex: 0 })).toBe('ChatGPT 1 session');
    expect(formatSuggestionProducts({ cowork: 5, code: 2, chatgpt: 0, codex: 0 })).toBe('Claude Cowork 5 sessions · Claude Code 2 sessions');
    expect(formatSuggestionProducts({ cowork: 0, code: 1, chatgpt: 0, codex: 4 })).toBe('Claude Code 1 session · Codex 4 sessions');
  });
});
