// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * "Work only one person does" on the Departments page, by Team Coaching's rule (soloWork in
 * lib/pulse/cowork/coaching-figures.ts), so the two pages and So What agree: a kind of work, at any
 * depth, that exactly one member does, with at least `minPrompts` prompts. Mechanism labels are
 * left out. Pure: the route reads the rows.
 */
export function soleWorkByPerson(
  rows: Array<{ user_id: string; task_type: string; prompts: number }>,
  opts: { minPrompts: number; skip: ReadonlySet<string>; label: (taskType: string) => string },
): Map<string, string[]> {
  const byType = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (opts.skip.has(r.task_type)) continue;
    const people = byType.get(r.task_type) ?? new Map<string, number>();
    people.set(r.user_id, (people.get(r.user_id) ?? 0) + r.prompts);
    byType.set(r.task_type, people);
  }
  const out = new Map<string, string[]>();
  for (const [taskType, people] of byType) {
    if (people.size !== 1) continue;
    const [uid, prompts] = [...people.entries()][0];
    if (prompts < opts.minPrompts) continue;
    out.set(uid, [...(out.get(uid) ?? []), opts.label(taskType)]);
  }
  return out;
}
