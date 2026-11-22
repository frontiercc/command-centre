// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * How the briefings write figures, worked out in code so the model copies the formatted form
 * rather than being asked to format it. Money in whole dollars with separators ($5,999.55 →
 * $6,000), counts with separators (1354 → 1,354), and shares that add up to 100. The number
 * check strips separators, so "$6,000" in the facts lets the model write "$6,000" or "6000".
 * Client-safe, no imports.
 */

/** Whole US dollars with thousands separators. Null stays null (not priced is never $0). */
export function briefingUsd(usd: number | string | null | undefined): string | null {
  if (usd === null || usd === undefined || usd === '') return null;
  const n = Number(usd);
  if (!Number.isFinite(n)) return null;
  const whole = Math.round(n);
  return `${whole < 0 ? '-' : ''}$${Math.abs(whole).toLocaleString('en-US')}`;
}

/** A count with thousands separators. */
export function briefingCount(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '0';
}

/**
 * Whole-number shares of a total that add up to exactly 100 (largest remainder), so three
 * rounded shares never read 26%, 49% and 26%. Null when the total is 0.
 */
export function wholeShares(counts: number[]): number[] | null {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const exact = counts.map(c => (c / total) * 100);
  const floors = exact.map(Math.floor);
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((e, i) => ({ i, rem: e - Math.floor(e) }))
    .sort((a, b) => b.rem - a.rem || counts[b.i] - counts[a.i] || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] += 1;
    left -= 1;
  }
  return floors;
}

/**
 * The largest of three tier counts, by the customer's tier name, or a tie stated as such, so the
 * model is told which kind of work led and cannot invert it.
 */
export function largestTierLine(names: [string, string, string], counts: [number, number, number]): string | null {
  const max = Math.max(...counts);
  if (max <= 0) return null;
  const top = names.filter((_, i) => counts[i] === max);
  return top.length === 1
    ? `Largest kind of work: ${top[0]}`
    : `Largest kind of work: ${top.join(' and ')}, level with each other`;
}
