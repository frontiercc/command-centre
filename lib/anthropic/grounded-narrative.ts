// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared grounding helpers for LLM narratives over deterministic facts.
 * Originally lifted verbatim from lib/finance/insight-narrative.ts; that file
 * now imports from here too (both callers share one copy) — do not fork a
 * local copy in either caller again.
 */

/** Rounded-to-whole, rounded-to-1dp, exact-value, and exact-2dp string forms of `n`
 *  (and its absolute value, so a negative fact number still matches an unsigned mention). */
export function numberVariants(n: number): string[] {
  if (!isFinite(n)) return [];
  const variants = new Set<string>([
    String(Math.round(n)),
    n.toFixed(1),
    String(n),
    n.toFixed(2),
    String(Math.round(Math.abs(n))),
    Math.abs(n).toFixed(1),
    String(Math.abs(n)),
    Math.abs(n).toFixed(2),
  ]);
  return [...variants];
}

/** Numeric tokens found in free text, thousands separators stripped. */
export function extractNumbers(text: string): string[] {
  const matches = text.match(/\d[\d,]*\.?\d*/g) ?? [];
  return matches.map(m => m.replace(/,/g, ''));
}

/** The numbers mentioned in `text` that are NOT derivable from `allowed`, in order
 *  of appearance, de-duplicated. Empty means grounded. Used to tell the model which
 *  figures it invented when asking it to try again. */
export function ungroundedNumbers(text: string, allowed: Set<string>): string[] {
  const out: string[] = [];
  for (const raw of extractNumbers(text)) {
    const n = parseFloat(raw);
    const ok = isFinite(n) && (allowed.has(raw) || numberVariants(n).some(v => allowed.has(v)));
    if (!ok && !out.includes(raw)) out.push(raw);
  }
  return out;
}

/** True only if every number mentioned in `text` is derivable from `facts`. */
export function isGrounded(text: string, allowed: Set<string>): boolean {
  return ungroundedNumbers(text, allowed).length === 0;
}
