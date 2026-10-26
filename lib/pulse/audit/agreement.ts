// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Classifier accuracy audit maths. Pure, no
// DB/IO — the credibility core of the audit, so it is unit-tested in isolation.
//
// Two deliberate choices:
//   - The audit sample oversamples hard/rare cases, so the PUBLISHED agreement
//     is REWEIGHTED to the production tier×confidence mix (rawAgreement is a
//     diagnostic only).
//   - Tiers are ORDINAL, so kappa is QUADRATIC-WEIGHTED: a T1↔T3 disagreement
//     counts as worse than a T1↔T2 one.

export interface AuditItem {
  /** Stratum key (e.g. `${tier}:${confidenceBand}`) the item was sampled from. */
  stratum: string;
  /** Did the human reviewer's tier match the classifier's tier? */
  agrees: boolean;
}

export interface TierPair {
  human: number;
  model: number;
}

/** Unweighted share of agreeing items (diagnostic — do NOT publish as accuracy). */
export function rawAgreement(items: AuditItem[]): number {
  if (items.length === 0) return 0;
  return items.filter(i => i.agrees).length / items.length;
}

/**
 * Population-weighted agreement: each stratum contributes its own agreement rate
 * weighted by its share of the PRODUCTION mix, not its share of the (enriched)
 * sample. Strata absent from the sample are skipped; the used weights are
 * renormalised so they sum to 1.
 */
export function reweightedAgreement(items: AuditItem[], productionWeights: Record<string, number>): number {
  const byStratum = new Map<string, { agree: number; total: number }>();
  for (const it of items) {
    const s = byStratum.get(it.stratum) ?? { agree: 0, total: 0 };
    s.total += 1;
    if (it.agrees) s.agree += 1;
    byStratum.set(it.stratum, s);
  }

  let weightSum = 0;
  let acc = 0;
  for (const [stratum, { agree, total }] of byStratum) {
    const w = productionWeights[stratum] ?? 0;
    if (w <= 0 || total === 0) continue;
    acc += w * (agree / total);
    weightSum += w;
  }
  return weightSum > 0 ? acc / weightSum : 0;
}

/**
 * 3×3 confusion matrix over ordinal categories (default tiers 1..3).
 * Rows = human tier, columns = model tier.
 */
export function confusionMatrix(pairs: TierPair[], categories: number[] = [1, 2, 3]): number[][] {
  const idx = new Map(categories.map((c, i) => [c, i]));
  const k = categories.length;
  const m = Array.from({ length: k }, () => Array(k).fill(0) as number[]);
  for (const { human, model } of pairs) {
    const r = idx.get(human);
    const c = idx.get(model);
    if (r === undefined || c === undefined) continue;
    m[r][c] += 1;
  }
  return m;
}

/**
 * Cohen's kappa with QUADRATIC disagreement weights over ordinal categories.
 * κ = 1 − (Σ d_ij O_ij) / (Σ d_ij E_ij), where d_ij = (i−j)² / (k−1)² and E is
 * the independence (expected) matrix from the marginals. Returns 1 for perfect
 * agreement; 0 when there is no expected disagreement to normalise against.
 */
export function quadraticWeightedKappa(pairs: TierPair[], categories: number[] = [1, 2, 3]): number {
  const k = categories.length;
  if (pairs.length === 0 || k < 2) return 0;

  const O = confusionMatrix(pairs, categories);
  const n = pairs.length;
  const rowTotals = O.map(row => row.reduce((a, b) => a + b, 0));
  const colTotals = categories.map((_, j) => O.reduce((a, row) => a + row[j], 0));

  const denom = (k - 1) * (k - 1);
  const d = (i: number, j: number) => ((i - j) * (i - j)) / denom;

  let observed = 0;
  let expected = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      const w = d(i, j);
      observed += w * O[i][j];
      expected += w * ((rowTotals[i] * colTotals[j]) / n);
    }
  }
  if (expected === 0) return observed === 0 ? 1 : 0;
  return 1 - observed / expected;
}
