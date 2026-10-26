// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Client-safe: how department suggestions are grouped into boxes, used by the
 * Use Cases page and the CIO "What to act on next" panel alike.
 *
 * One box per department. Inside it, suggestions found in Cowork
 * prompts and in Claude Code prompts are two lists, each ranked by the people
 * behind a suggestion, then its sessions; the box shows the top few of each
 * and Review steps through all of them. Splitting such a department into two
 * boxes made the page a wall of boxes on a hub with many departments. Older
 * rows carry no surface and were all found in Cowork.
 */
export type SuggestionSurface = 'cowork' | 'code';

export interface BoxableSuggestion {
  department: string | null;
  surface?: SuggestionSurface | null;
  /** The measured people and sessions behind a mined suggestion; ranks it within its list. */
  canvas?: { people?: number; sessions?: number } | null;
}

export interface DeptBoxGroup<S> {
  surface: SuggestionSurface;
  label: string;
  /** Every open suggestion from this surface, ranked. */
  suggestions: S[];
}

export interface DeptBox<S> {
  /** Stable key for React. */
  key: string;
  department: string;
  label: string;
  count: number;
  /** Every suggestion in the box, in the order Review steps through them: Cowork, then Claude Code, each ranked. */
  suggestions: S[];
  /** Cowork first, then Claude Code; a surface with no suggestions has no group. */
  groups: DeptBoxGroup<S>[];
}

export const SURFACE_LABEL: Record<SuggestionSurface, string> = { cowork: 'Cowork', code: 'Claude Code' };

/** How many titles each list in a box shows; the rest are reached through Review. */
export const TITLES_PER_GROUP = 3;

export const surfaceOf = (s: BoxableSuggestion): SuggestionSurface => (s.surface === 'code' ? 'code' : 'cowork');

const SURFACE_ORDER: SuggestionSurface[] = ['cowork', 'code'];

/** People first, then sessions; ties keep the order given (newest first from the store). */
function rank<S extends BoxableSuggestion>(list: S[]): S[] {
  return list
    .map((s, i) => ({ s, i }))
    .sort((a, b) =>
      (b.s.canvas?.people ?? 0) - (a.s.canvas?.people ?? 0)
      || (b.s.canvas?.sessions ?? 0) - (a.s.canvas?.sessions ?? 0)
      || a.i - b.i)
    .map(x => x.s);
}

/** Department suggestions (department set) grouped into one box per department, alphabetical. */
export function groupDeptBoxes<S extends BoxableSuggestion>(suggestions: S[]): DeptBox<S>[] {
  const byDept = new Map<string, S[]>();
  for (const s of suggestions) {
    if (!s.department) continue;
    (byDept.get(s.department) ?? byDept.set(s.department, []).get(s.department)!).push(s);
  }
  const boxes: DeptBox<S>[] = [];
  for (const [department, list] of byDept) {
    const groups = SURFACE_ORDER
      .map(surface => ({ surface, label: SURFACE_LABEL[surface], suggestions: rank(list.filter(s => surfaceOf(s) === surface)) }))
      .filter(g => g.suggestions.length > 0);
    boxes.push({
      key: department, department, label: department, count: list.length,
      suggestions: groups.flatMap(g => g.suggestions), groups,
    });
  }
  return boxes.sort((a, b) => a.department.localeCompare(b.department));
}
