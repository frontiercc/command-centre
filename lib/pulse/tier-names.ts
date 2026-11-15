// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * What this customer calls each tier. Every chart, grid and sentence on the Pulse pages reads
 * these names, so renaming a tier on Admin → Work Pulse → Tiers renames it on the pages too.
 * Client-safe, no imports; the server reads the saved rubric with getTierNames() in tier-config.ts.
 */

export interface TierNames { t1: string; t2: string; t3: string }

/** The names in the shipped rubric (lib/pulse/tier-config.ts DEFAULT_TIER_CONFIG). */
export const DEFAULT_TIER_NAMES: TierNames = { t1: 'Administrative', t2: 'Meaningful', t3: 'Frontier' };

export function tierNamesOr(names: TierNames | null | undefined): TierNames {
  return names ?? DEFAULT_TIER_NAMES;
}

/**
 * Stored text that names a tier by number ("Tier 3 session flagged as …"), shown with the
 * customer's name for that tier instead, so a renamed tier reads correctly on old rows too.
 */
export function withTierNames(text: string, names: TierNames | null | undefined): string {
  const t = tierNamesOr(names);
  const list = [t.t1, t.t2, t.t3];
  return text.replace(/\bTier ([123])\b/g, (_, n: string) => list[Number(n) - 1]);
}

/**
 * The top tier where a figure mixes Work Pulse and Developer Pulse sessions (Spend Review's
 * efficiency boards). The shipped names are "Frontier" and "Frontier delegation": when one name
 * begins with the other, the shorter one covers both. Names renamed apart are both given.
 */
export function topTierName(work: TierNames | null | undefined, code: TierNames | null | undefined): string {
  const w = tierNamesOr(work).t3, c = tierNamesOr(code).t3;
  const lw = w.toLowerCase(), lc = c.toLowerCase();
  if (lc.startsWith(lw)) return w;
  if (lw.startsWith(lc)) return c;
  return `${w} or ${c}`;
}

/** The top two tiers, as the customer names them: "meaningful or frontier". */
export function deepWords(names: TierNames | null | undefined): string {
  const t = tierNamesOr(names);
  return `${t.t2.toLowerCase()} or ${t.t3.toLowerCase()}`;
}

/** The same, capitalised to open a sentence or label a card. */
export function DeepWords(names: TierNames | null | undefined): string {
  const w = deepWords(names);
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/**
 * The share of judged tasks in the two deeper tiers, from tier counts: what the pages describe a
 * person's or a team's work with, in place of the old depth score. Null when nothing was judged.
 */
export function deepShareOf(t1: number | null | undefined, t2: number | null | undefined, t3: number | null | undefined): number | null {
  const a = Number(t1 ?? 0), b = Number(t2 ?? 0), c = Number(t3 ?? 0);
  const total = a + b + c;
  return total > 0 ? (b + c) / total : null;
}

/** The three names lowest first, for a chart legend or grid rows. */
export function tierList(names: TierNames | null | undefined): [string, string, string] {
  const t = tierNamesOr(names);
  return [t.t1, t.t2, t.t3];
}
