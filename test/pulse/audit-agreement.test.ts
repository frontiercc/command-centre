// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Classifier accuracy audit maths (metric-refinements §2c/2d). The headline
// agreement is REWEIGHTED to the production tier×confidence mix (the sample is
// deliberately enriched for hard cases), and kappa is QUADRATIC-WEIGHTED
// because tiers are ordinal (a T1↔T3 miss is worse than T1↔T2).
import { describe, it, expect } from 'vitest';
import {
  rawAgreement,
  reweightedAgreement,
  quadraticWeightedKappa,
  confusionMatrix,
} from '@/lib/pulse/audit/agreement';

describe('rawAgreement', () => {
  it('is the unweighted share of agreeing items', () => {
    const items = [
      { stratum: 'a', agrees: true },
      { stratum: 'a', agrees: false },
      { stratum: 'b', agrees: true },
      { stratum: 'b', agrees: true },
    ];
    expect(rawAgreement(items)).toBeCloseTo(0.75, 5);
  });

  it('is 0 for an empty sample', () => {
    expect(rawAgreement([])).toBe(0);
  });
});

describe('reweightedAgreement (§2a/2c — correct the oversampled headline)', () => {
  it('weights each stratum by its production share, not its sample share', () => {
    // Stratum A is oversampled (10 items) and hard (50% agreement); B is small
    // (2 items) and easy (100%). Raw agreement understates the truth because A
    // is over-represented in the sample.
    const items = [
      ...Array.from({ length: 10 }, (_, i) => ({ stratum: 'A', agrees: i < 5 })), // 5/10
      { stratum: 'B', agrees: true },
      { stratum: 'B', agrees: true }, // 2/2
    ];
    expect(rawAgreement(items)).toBeCloseTo(7 / 12, 5); // 0.5833…
    // In production A is rare (20%), B common (80%).
    const weighted = reweightedAgreement(items, { A: 0.2, B: 0.8 });
    expect(weighted).toBeCloseTo(0.2 * 0.5 + 0.8 * 1.0, 5); // 0.90
  });

  it('ignores strata with a zero production weight and renormalises', () => {
    const items = [
      { stratum: 'A', agrees: true },
      { stratum: 'B', agrees: false },
    ];
    // Only A has production presence → headline is A's rate (1.0).
    expect(reweightedAgreement(items, { A: 1, B: 0 })).toBeCloseTo(1.0, 5);
  });
});

describe('quadraticWeightedKappa (ordinal tiers 1..3)', () => {
  it('is 1.0 for perfect agreement', () => {
    const pairs = [
      { human: 1, model: 1 }, { human: 2, model: 2 }, { human: 3, model: 3 },
      { human: 2, model: 2 }, { human: 1, model: 1 },
    ];
    expect(quadraticWeightedKappa(pairs)).toBeCloseTo(1.0, 5);
  });

  it('matches a hand-computed value (κ = 0.6429)', () => {
    // Confusion: O[1][1]=3, O[1][2]=1, O[2][1]=1, O[2][2]=2, O[2][3]=1, O[3][2]=1, O[3][3]=1
    // (tier space). Do = 1.0, De = 2.8 → κ = 1 − 1.0/2.8 = 0.642857…
    const pairs = [
      { human: 1, model: 1 }, { human: 1, model: 1 }, { human: 1, model: 1 },
      { human: 1, model: 2 },
      { human: 2, model: 1 },
      { human: 2, model: 2 }, { human: 2, model: 2 },
      { human: 2, model: 3 },
      { human: 3, model: 2 },
      { human: 3, model: 3 },
    ];
    expect(quadraticWeightedKappa(pairs)).toBeCloseTo(0.642857, 4);
  });

  it('penalises a T1↔T3 miss more than a T1↔T2 miss (ordinal weighting)', () => {
    const base = [
      { human: 1, model: 1 }, { human: 2, model: 2 }, { human: 3, model: 3 },
      { human: 1, model: 1 }, { human: 2, model: 2 }, { human: 3, model: 3 },
    ];
    const nearMiss = [...base, { human: 1, model: 2 }];
    const farMiss = [...base, { human: 1, model: 3 }];
    expect(quadraticWeightedKappa(nearMiss)).toBeGreaterThan(quadraticWeightedKappa(farMiss));
  });
});

describe('confusionMatrix', () => {
  it('builds a 3×3 human(row)×model(col) count matrix', () => {
    const pairs = [
      { human: 1, model: 1 }, { human: 1, model: 2 },
      { human: 2, model: 2 }, { human: 3, model: 1 },
    ];
    expect(confusionMatrix(pairs)).toEqual([
      [1, 1, 0],
      [0, 1, 0],
      [1, 0, 0],
    ]);
  });
});
