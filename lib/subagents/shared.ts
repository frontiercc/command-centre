// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Claude subagents register: types and the built-in/custom rule.
 * Client-safe (no server imports): the admin page and the route both use it.
 */

/** Activity window for the register, in days. */
export const SUBAGENT_WINDOW_DAYS = 30;
/** A custom subagent first seen within this many days is tagged New. */
export const SUBAGENT_NEW_DAYS = 7;

/**
 * Claude Code's own subagents. OTel's query_source names them
 * (`agent:builtin:<name>`) on recent clients; this list covers rows that carry
 * no query_source, such as Cowork launches.
 */
export const BUILT_IN_SUBAGENTS: ReadonlySet<string> = new Set([
  'general-purpose',
  'explore',
  'plan',
  'fork',
  'claude-code-guide',
  'statusline-setup',
  'output-style-setup',
  'workflow-subagent',
]);

export type SubagentKind = 'built_in' | 'custom';
/**
 * Where a subagent comes from: Claude's own, a plugin (`plugin:agent`), the
 * person's own definition, or withheld (the client sends "custom" instead of
 * the name when it does not send tool details).
 */
export type SubagentSource = 'built_in' | 'plugin' | 'own' | 'withheld';

export interface SubagentClass {
  kind: SubagentKind;
  source: SubagentSource;
  /** Plugin name, when source is 'plugin'. */
  plugin: string | null;
}

export function classifySubagent(name: string, querySource: string | null | undefined): SubagentClass {
  const qs = (querySource ?? '').toLowerCase();
  if (name.trim().toLowerCase() === 'custom') return { kind: 'custom', source: 'withheld', plugin: null };
  const builtIn = qs.startsWith('agent:builtin')
    || (!qs.startsWith('agent:custom') && BUILT_IN_SUBAGENTS.has(name.trim().toLowerCase()));
  if (builtIn) return { kind: 'built_in', source: 'built_in', plugin: null };
  const colon = name.indexOf(':');
  if (colon > 0) return { kind: 'custom', source: 'plugin', plugin: name.slice(0, colon) };
  return { kind: 'custom', source: 'own', plugin: null };
}

export type SubagentSurface = 'code' | 'cowork';

export interface SubagentModelSpend {
  model: string;
  /** Measured or list-priced spend; null when the model has no price. */
  spendUsd: number | null;
}

export interface SubagentPerson {
  name: string;
  department: string | null;
  surfaces: SubagentSurface[];
  sessions: number;
  /** Model calls made inside the subagent. */
  calls: number;
  /** Cowork launches of the subagent. */
  launches: number;
  spendUsd: number | null;
  models: string[];
}

export interface SubagentRow {
  name: string;
  kind: SubagentKind;
  source: SubagentSource;
  plugin: string | null;
  surfaces: SubagentSurface[];
  models: SubagentModelSpend[];
  people: number;
  sessions: number;
  calls: number;
  launches: number;
  /** Null when none of its spend could be priced. */
  spendUsd: number | null;
  /** Epoch seconds, over all stored history. */
  firstSeen: number;
  lastSeen: number;
  isNew: boolean;
  byPerson: SubagentPerson[];
}

export interface SubagentRegister {
  windowDays: number;
  newDays: number;
  generatedAt: number;
  rows: SubagentRow[];
  totals: {
    subagents: number;
    custom: number;
    builtIn: number;
    newCustom: number;
    /** Priced Claude Code spend inside subagents, and all priced Claude Code spend. */
    codeSubagentSpendUsd: number | null;
    codeTotalSpendUsd: number | null;
    /** Cowork spend inside named subagents (captured since migration 0036), and all Cowork spend. */
    coworkSubagentSpendUsd: number | null;
    coworkTotalSpendUsd: number | null;
    coworkLaunches: number;
    coworkLaunchPeople: number;
  };
  /** Models seen inside subagents with no price in Admin, Developer Pulse rates. */
  unpricedModels: string[];
}

/** Share as a fraction, or null when either side is missing or the total is zero. */
export function spendShare(part: number | null, total: number | null): number | null {
  if (part === null || total === null || total <= 0) return null;
  return part / total;
}
