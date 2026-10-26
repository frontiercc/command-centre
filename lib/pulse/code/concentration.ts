// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Spend concentration — how much of total Code spend comes from the top few users.
 *
 * A structural/governance signal (key-person & automation-runaway risk), not a
 * verdict: "the top spender is 40% of spend" tells you whether cost is broad-based
 * or carried by a handful of accounts. Mirrors the cumulative top-1/5/10 % view in
 * Claude's native Value tab, but computed deterministically from our own priced
 * per-user spend — measured, not estimated.
 */

/** Minimum number of priced spenders before concentration is a meaningful signal. */
export const MIN_SPENDERS_FOR_CONCENTRATION = 5;

/** Cumulative top-N tiers we report, matching the native dashboard. */
export const CONCENTRATION_TIERS = [1, 5, 10] as const;

export interface SpendConcentration {
  /** Number of users with priced spend > 0 in the window. */
  spenderCount: number;
  /** Total priced spend across all spenders (USD). */
  totalSpend: number;
  /** Cumulative share (0..1) of spend held by the top N spenders, for each tier. */
  tiers: Array<{ topN: number; share: number }>;
}

/**
 * Compute cumulative spend concentration from a list of per-user spend amounts.
 *
 * Returns null when there are too few spenders for the signal to mean anything
 * (below `MIN_SPENDERS_FOR_CONCENTRATION`) or when total spend is zero — the card
 * hides rather than showing a trivial "top 1 = 100%".
 *
 * Only tiers strictly smaller than the spender count are returned, so every tier
 * represents a genuine subset of the whole (never "top 10 of 7 users = 100%").
 */
export function computeSpendConcentration(spends: number[]): SpendConcentration | null {
  const ranked = spends.filter(s => s > 0).sort((a, b) => b - a);
  const totalSpend = ranked.reduce((a, b) => a + b, 0);
  if (ranked.length < MIN_SPENDERS_FOR_CONCENTRATION || totalSpend <= 0) return null;

  const tiers = CONCENTRATION_TIERS.filter(n => n < ranked.length).map(topN => {
    const head = ranked.slice(0, topN).reduce((a, b) => a + b, 0);
    return { topN, share: head / totalSpend };
  });
  if (tiers.length === 0) return null;

  return { spenderCount: ranked.length, totalSpend, tiers };
}
