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

/** The three names lowest first, for a chart legend or grid rows. */
export function tierList(names: TierNames | null | undefined): [string, string, string] {
  const t = tierNamesOr(names);
  return [t.t1, t.t2, t.t3];
}
