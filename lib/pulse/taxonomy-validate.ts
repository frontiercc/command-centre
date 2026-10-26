// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Checks the Cowork task-type taxonomy before it is saved (/admin/pulse →
 * Tiers). Without it, a row whose name had been cleared was saved as an
 * empty label: the model then saw a nameless line in its instructions, and an
 * empty task_type counted as valid. Pure, client-safe.
 */
export const TASK_TYPE_NAME_RE = /^[a-z][a-z0-9_]*$/;

type Taxonomy = Record<'tier1' | 'tier2' | 'tier3', { name?: unknown }[] | undefined>;

/** Returns an error for the admin to read, or null when the taxonomy is valid. */
export function validateTaxonomy(taxonomy: Taxonomy | undefined): string | null {
  if (!taxonomy) return 'The task type taxonomy is missing.';
  const seen = new Set<string>();
  let total = 0;
  for (const [tier, label] of [['tier1', 'Tier 1'], ['tier2', 'Tier 2'], ['tier3', 'Tier 3']] as const) {
    const rows = taxonomy[tier];
    if (!Array.isArray(rows)) return `The ${label} task type list is missing.`;
    for (const row of rows) {
      const name = typeof row?.name === 'string' ? row.name.trim() : '';
      if (!name) return `A ${label} task type has no name. Give it a name or remove the row with ✕.`;
      if (!TASK_TYPE_NAME_RE.test(name)) return `"${name}" is not a valid task type name: use lowercase letters, digits and underscores, starting with a letter.`;
      if (seen.has(name)) return `"${name}" appears more than once. Each task type name must be unique.`;
      seen.add(name);
      total++;
    }
  }
  if (total === 0) return 'The taxonomy needs at least one task type.';
  return null;
}
