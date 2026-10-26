// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { buildInsightFacts } from '@/lib/finance/insights';
import type { ChargebackReport } from '@/lib/finance/chargeback';
import type { SpendProjection } from '@/lib/pulse/code/projection';

// Minimal hand-built ChargebackReport-shaped fixtures — only the fields
// buildInsightFacts actually reads are populated; the rest is cast `as any`.
function makeReport(opts: {
  centres: Array<{ name: string; totalUsd: number }>;
  unallocatedUsd: number;
  unpricedModels: string[];
  estimated: boolean;
  leaderboard?: Array<{ totalUsd: number }>;
}): ChargebackReport {
  const centresTotal = opts.centres.reduce((s, c) => s + c.totalUsd, 0);
  const grandTotalUsd = centresTotal + opts.unallocatedUsd;
  return {
    costCentres: opts.centres.map(c => ({
      name: c.name,
      code: null,
      totalUsd: c.totalUsd,
      codeUsd: c.totalUsd,
      coworkUsd: 0,
      users: [],
    })),
    unallocated: { totalUsd: opts.unallocatedUsd, users: [] },
    grandTotalUsd,
    unpricedModels: opts.unpricedModels,
    estimated: opts.estimated,
    leaderboard: (opts.leaderboard ?? []).map((u, i) => ({
      userId: `u-${i}`,
      displayName: `User ${i}`,
      totalUsd: u.totalUsd,
      codeUsd: u.totalUsd,
      coworkUsd: 0,
    })),
  } as any as ChargebackReport;
}

describe('buildInsightFacts', () => {
  const current = makeReport({
    centres: [
      { name: 'R&D', totalUsd: 75 },
      { name: 'Legal', totalUsd: 10 },
    ],
    unallocatedUsd: 8,
    unpricedModels: ['some-unknown-model'],
    estimated: true,
  });

  const prior = makeReport({
    centres: [
      { name: 'R&D', totalUsd: 54 },
      { name: 'Legal', totalUsd: 10 },
    ],
    unallocatedUsd: 0,
    unpricedModels: [],
    estimated: false,
  });

  it('finds R&D as the biggest mover with correct $ and % delta', () => {
    const facts = buildInsightFacts(current, prior, null);

    expect(facts.biggestMover).not.toBeNull();
    expect(facts.biggestMover!.centre).toBe('R&D');
    expect(facts.biggestMover!.deltaUsd).toBeCloseTo(21, 6);
    // 21 / 54 * 100
    expect(facts.biggestMover!.deltaPct).toBeCloseTo((21 / 54) * 100, 6);
  });

  it('computes topCentrePct as the top centre share of grand total', () => {
    const facts = buildInsightFacts(current, prior, null);
    const grand = 75 + 10 + 8;
    expect(facts.concentration.topCentrePct).toBeCloseTo((75 / grand) * 100, 6);
  });

  it('computes data-quality fields (unallocated %, unpriced count, estimated flag)', () => {
    const facts = buildInsightFacts(current, prior, null);
    const grand = 75 + 10 + 8;
    expect(facts.dataQuality.unallocatedPct).toBeCloseTo((8 / grand) * 100, 6);
    expect(facts.dataQuality.unpricedModelCount).toBe(1);
    expect(facts.dataQuality.estimated).toBe(true);
  });

  it('compares a month in progress with last month at the same pace', () => {
    // Day 15 of 30: last month's 54 for R&D scales to 27, so 75 is 48 ahead.
    const projection: SpendProjection = { projected: 186, daysElapsed: 15, daysInMonth: 30 };
    const m = buildInsightFacts(current, prior, projection).biggestMover!;
    expect(m.centre).toBe('R&D');
    expect(m.atPace).toBe(true);
    expect(m.deltaUsd).toBeCloseTo(75 - 27, 6);
    expect(m.deltaPct).toBeCloseTo(((75 - 27) / 27) * 100, 6);
  });

  it('leaves the biggest mover out before day 7 of a month in progress', () => {
    const projection: SpendProjection = { projected: 900, daysElapsed: 3, daysInMonth: 31 };
    expect(buildInsightFacts(current, prior, projection).biggestMover).toBeNull();
  });

  it('returns biggestMover=null and projection=null when prior is null', () => {
    const projection: SpendProjection = { projected: 120, daysElapsed: 15, daysInMonth: 30 };
    const facts = buildInsightFacts(current, null, projection);

    expect(facts.biggestMover).toBeNull();
    expect(facts.projection).toBeNull();
    // topCentrePct / dataQuality still computable from `current` alone.
    expect(facts.concentration.topCentrePct).not.toBeNull();
  });

  it('never picks a non-positive delta as the biggest mover (Legal is flat)', () => {
    const flatCurrent = makeReport({
      centres: [{ name: 'Legal', totalUsd: 10 }],
      unallocatedUsd: 0,
      unpricedModels: [],
      estimated: false,
    });
    const flatPrior = makeReport({
      centres: [{ name: 'Legal', totalUsd: 10 }],
      unallocatedUsd: 0,
      unpricedModels: [],
      estimated: false,
    });
    const facts = buildInsightFacts(flatCurrent, flatPrior, null);
    expect(facts.biggestMover).toBeNull();
  });

  it('guards every percentage against divide-by-zero (grand total = 0)', () => {
    const zeroReport = makeReport({
      centres: [],
      unallocatedUsd: 0,
      unpricedModels: [],
      estimated: false,
    });
    const facts = buildInsightFacts(zeroReport, null, null);
    expect(facts.concentration.topCentrePct).toBeNull();
    expect(facts.dataQuality.unallocatedPct).toBe(0);
  });

  it('leaves the projection out before day 7, when a run rate is mostly noise', () => {
    const projection: SpendProjection = { projected: 1323, daysElapsed: 3, daysInMonth: 31 };
    expect(buildInsightFacts(current, prior, projection).projection).toBeNull();
  });

  it('computes projection vs prior total when both projection and prior are present', () => {
    const projection: SpendProjection = { projected: 120, daysElapsed: 15, daysInMonth: 30 };
    const facts = buildInsightFacts(current, prior, projection);

    expect(facts.projection).not.toBeNull();
    expect(facts.projection!.projectedUsd).toBe(120);
    expect(facts.projection!.priorUsd).toBeCloseTo(64, 6); // 54 + 10
    expect(facts.projection!.vsPriorPct).toBeCloseTo(((120 - 64) / 64) * 100, 6);
  });

  it('topUsersPct is null below the minimum-spender threshold (fewer than 5 priced users)', () => {
    // Only 2 leaderboard entries — well below MIN_SPENDERS_FOR_CONCENTRATION.
    const thin = makeReport({
      centres: [{ name: 'R&D', totalUsd: 75 }],
      unallocatedUsd: 0,
      unpricedModels: [],
      estimated: false,
      leaderboard: [{ totalUsd: 50 }, { totalUsd: 25 }],
    });
    const facts = buildInsightFacts(thin, null, null);
    expect(facts.concentration.topUsersPct).toBeNull();
  });

  it('topUsersPct is computed from the leaderboard once there are enough spenders', () => {
    const rich = makeReport({
      centres: [{ name: 'R&D', totalUsd: 100 }],
      unallocatedUsd: 0,
      unpricedModels: [],
      estimated: false,
      leaderboard: [
        { totalUsd: 50 },
        { totalUsd: 20 },
        { totalUsd: 15 },
        { totalUsd: 10 },
        { totalUsd: 5 },
      ],
    });
    const facts = buildInsightFacts(rich, null, null);
    // Top-1 share of the 5 leaderboard spenders: 50 / (50+20+15+10+5) = 50/100.
    expect(facts.concentration.topUsersPct).toBeCloseTo(50, 6);
  });
});
