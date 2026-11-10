// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * The department sync rules, as pure functions (no database, no network), so
 * every rule can be tested on its own. Client-safe.
 *
 * - A directory name is tidied (spaces trimmed and collapsed) before use.
 * - An admin's name map wins ("Eng" → "Engineering"), matched regardless of
 *   capitals and spacing.
 * - Otherwise the name matches an existing department regardless of capitals
 *   and spacing, keeping the existing spelling, so "engineering " never
 *   becomes a second Engineering.
 * - Otherwise it is a new department, under its tidied name.
 * - An empty directory value never changes anything.
 * - A department an admin set by hand ('manual') is never changed.
 * - A change is a move (FinOps splits the month at it) only when the
 *   directory had already set this person's department before, and both the
 *   old and new departments are real.
 */

/** Trims and collapses whitespace; '' for nothing. */
export function tidyDepartment(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim();
}

/** The comparison key: tidied and lower-cased. */
export function departmentKey(raw: string | null | undefined): string {
  return tidyDepartment(raw).toLowerCase();
}

/** Parses the stored name map (JSON object). Anything malformed is treated as no map. */
export function parseDepartmentMap(json: string | null | undefined): Record<string, string> {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) {
      if (typeof val !== 'string') continue;
      const key = tidyDepartment(k);
      const target = tidyDepartment(val);
      if (key && target) out[key] = target;
    }
    return out;
  } catch {
    return {};
  }
}

export type MatchedBy = 'map' | 'existing' | 'new';

export interface ResolvedDepartment {
  /** The Command Centre department to use. */
  department: string;
  matchedBy: MatchedBy;
}

/**
 * Resolves directory names to Command Centre departments. Remembers names it
 * has resolved as new, so the same name later in the same run (in any
 * spelling) lands on the same department.
 */
export class DepartmentResolver {
  private readonly mapByKey = new Map<string, string>();
  private readonly existingByKey = new Map<string, string>();

  constructor(existing: Iterable<string | null | undefined>, map: Record<string, string>) {
    for (const d of existing) {
      const name = tidyDepartment(d);
      const key = name.toLowerCase();
      if (key && !this.existingByKey.has(key)) this.existingByKey.set(key, name);
    }
    for (const [from, to] of Object.entries(map)) {
      const key = departmentKey(from);
      if (key) this.mapByKey.set(key, tidyDepartment(to));
    }
  }

  /** null when the directory value is empty. */
  resolve(raw: string | null | undefined): ResolvedDepartment | null {
    const name = tidyDepartment(raw);
    if (!name) return null;
    const key = name.toLowerCase();
    const mapped = this.mapByKey.get(key);
    if (mapped) {
      // A mapped target matches an existing spelling too.
      const existing = this.existingByKey.get(mapped.toLowerCase());
      const department = existing ?? mapped;
      if (!existing) this.existingByKey.set(mapped.toLowerCase(), mapped);
      return { department, matchedBy: 'map' };
    }
    const existing = this.existingByKey.get(key);
    if (existing) return { department: existing, matchedBy: 'existing' };
    this.existingByKey.set(key, name);
    return { department: name, matchedBy: 'new' };
  }
}

export type DepartmentSource = 'directory' | 'manual' | null;

export interface PersonDepartmentState {
  /** The person's current department (login account first, else monitored person). */
  current: string | null;
  /** The sources on the person's rows (login account and monitored person). */
  sources: DepartmentSource[];
}

export type Decision =
  | { action: 'skip'; reason: 'manual' | 'empty' }
  | { action: 'unchanged'; department: string }
  | { action: 'change'; department: string; isMove: boolean };

export function decideDepartment(person: PersonDepartmentState, resolved: ResolvedDepartment | null): Decision {
  if (person.sources.includes('manual')) return { action: 'skip', reason: 'manual' };
  if (!resolved) return { action: 'skip', reason: 'empty' };
  const current = tidyDepartment(person.current);
  if (current === resolved.department) return { action: 'unchanged', department: resolved.department };
  const isMove = person.sources.includes('directory') && current !== '';
  return { action: 'change', department: resolved.department, isMove };
}

/** Every address a directory entry is known by, lower-cased and de-duplicated. */
export function normaliseEmails(addresses: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const a of addresses) {
    if (typeof a !== 'string') continue;
    // Exchange proxy addresses arrive as "smtp:alias@x" or "SMTP:primary@x".
    const v = a.replace(/^smtp:/i, '').trim().toLowerCase();
    if (v.includes('@')) out.add(v);
  }
  return [...out];
}
