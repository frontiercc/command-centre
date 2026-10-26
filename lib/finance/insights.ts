// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic insight facts over a chargeback report — pure arithmetic,
 * NO LLM. This is the grounded fact layer the narrative generator is
 * required to restate verbatim (never invent numbers beyond these).
 *
 * Every percentage is guarded against divide-by-zero: an undefined ratio
 * becomes `null`, never a fabricated 0% or 100%.
 */
import type { ChargebackReport } from '@/lib/finance/chargeback';
import type { SpendProjection } from '@/lib/pulse/code/projection';
import { computeSpendConcentration } from '@/lib/pulse/code/concentration';
import { MIN_PROJECTION_DAYS } from '@/lib/finance/finops-projection';

export interface InsightFacts {
  /** Cost centre with the largest positive spend increase vs the prior period, or null. For the month in
   *  progress the prior month is scaled to the same point in the month (`atPace`), never compared whole. */
  biggestMover: { centre: string; deltaUsd: number; deltaPct: number | null; atPace: boolean } | null;
  concentration: { topCentrePct: number | null; topUsersPct: number | null };
  /** Month-end projection vs the prior period's actual total, or null when either input is absent. */
  projection: { projectedUsd: number; priorUsd: number; vsPriorPct: number | null } | null;
  dataQuality: { unallocatedPct: number; unpricedModelCount: number; estimated: boolean };
}

/** Ratio-as-percent, guarding divide-by-zero → null (never a fabricated %). */
function safePct(numerator: number, denominator: number): number | null {
  if (!denominator) return null;
  return (numerator / denominator) * 100;
}

function computeBiggestMover(
  current: ChargebackReport,
  prior: ChargebackReport | null,
  projection: SpendProjection | null
): InsightFacts['biggestMover'] {
  if (!prior || current.costCentres.length === 0) return null;
  // Month in progress (a projection exists only then): compare with last month at the same pace,
  // the rule Spend Review's report already uses, and not before day MIN_PROJECTION_DAYS. Comparing a
  // few days against a whole month read as "HR up 71%" on 3 October.
  const atPace = projection !== null;
  if (atPace && projection.daysElapsed < MIN_PROJECTION_DAYS) return null;
  const pace = atPace ? projection.daysElapsed / Math.max(1, projection.daysInMonth) : 1;

  const priorByName = new Map(prior.costCentres.map(c => [c.name, c.totalUsd]));

  let best: InsightFacts['biggestMover'] = null;
  for (const centre of current.costCentres) {
    const priorTotal = (priorByName.get(centre.name) ?? 0) * pace;
    const deltaUsd = centre.totalUsd - priorTotal;
    if (deltaUsd <= 0) continue; // only the largest POSITIVE mover counts
    if (!best || deltaUsd > best.deltaUsd) {
      best = { centre: centre.name, deltaUsd, deltaPct: safePct(deltaUsd, priorTotal), atPace };
    }
  }
  return best;
}

function computeConcentration(current: ChargebackReport): InsightFacts['concentration'] {
  const topCentre = current.costCentres.reduce<ChargebackReport['costCentres'][number] | null>(
    (max, c) => (!max || c.totalUsd > max.totalUsd ? c : max),
    null
  );
  const topCentrePct = topCentre ? safePct(topCentre.totalUsd, current.grandTotalUsd) : null;

  // Top-users concentration over the leaderboard's per-user totals; the
  // smallest reported tier (topN=1) is the most concentrated slice —
  // computeSpendConcentration itself returns null below the minimum-spender
  // threshold, so a thin org never shows a misleadingly precise %.
  const spendConcentration = computeSpendConcentration(current.leaderboard.map(u => u.totalUsd));
  const topUsersPct = spendConcentration ? spendConcentration.tiers[0].share * 100 : null;

  return { topCentrePct, topUsersPct };
}

function computeProjection(
  prior: ChargebackReport | null,
  projection: SpendProjection | null
): InsightFacts['projection'] {
  if (!projection || !prior) return null;
  // Too early in the month for a run rate to mean anything (see MIN_PROJECTION_DAYS).
  if (projection.daysElapsed < MIN_PROJECTION_DAYS) return null;
  const priorUsd = prior.grandTotalUsd;
  return {
    projectedUsd: projection.projected,
    priorUsd,
    vsPriorPct: safePct(projection.projected - priorUsd, priorUsd),
  };
}

function computeDataQuality(current: ChargebackReport): InsightFacts['dataQuality'] {
  return {
    unallocatedPct: safePct(current.unallocated.totalUsd, current.grandTotalUsd) ?? 0,
    unpricedModelCount: current.unpricedModels.length,
    estimated: current.estimated,
  };
}

export function buildInsightFacts(
  current: ChargebackReport,
  prior: ChargebackReport | null,
  projection: SpendProjection | null
): InsightFacts {
  return {
    biggestMover: computeBiggestMover(current, prior, projection),
    concentration: computeConcentration(current),
    projection: computeProjection(prior, projection),
    dataQuality: computeDataQuality(current),
  };
}

/**
 * Deterministic prose summary built ENTIRELY from the computed facts — no LLM,
 * no network, no invented numbers. Replaces the previous grounded-LLM narrative
 * so the FinOps page renders without a synchronous Claude call. Every figure
 * here comes straight from `InsightFacts`.
 */
export function composeInsightNarrative(facts: InsightFacts): string {
  const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const pct = (n: number) => `${Math.round(n)}%`;
  const parts: string[] = [];

  if (facts.biggestMover) {
    const m = facts.biggestMover;
    const dir = m.deltaUsd >= 0 ? 'up' : 'down';
    const pctPart = m.deltaPct != null ? ` (${pct(Math.abs(m.deltaPct))})` : '';
    parts.push(m.atPace
      ? `${m.centre} is running furthest ahead of last month's pace, ${dir} ${usd(Math.abs(m.deltaUsd))}${pctPart}.`
      : `${m.centre} saw the largest change, ${dir} ${usd(Math.abs(m.deltaUsd))}${pctPart} versus last month.`);
  }
  if (facts.concentration.topCentrePct != null) {
    parts.push(`The top cost centre accounts for ${pct(facts.concentration.topCentrePct)} of spend.`);
  }
  if (facts.projection) {
    const p = facts.projection;
    const vs = p.vsPriorPct != null ? `, ${p.vsPriorPct >= 0 ? 'up' : 'down'} ${pct(Math.abs(p.vsPriorPct))} on last month` : '';
    parts.push(`At the current run-rate the month is on pace for ${usd(p.projectedUsd)}${vs}.`);
  }
  const dq: string[] = [];
  if (facts.dataQuality.unallocatedPct > 0) dq.push(`${pct(facts.dataQuality.unallocatedPct)} unallocated`);
  if (facts.dataQuality.unpricedModelCount > 0) {
    dq.push(`${facts.dataQuality.unpricedModelCount} unpriced model${facts.dataQuality.unpricedModelCount > 1 ? 's' : ''}`);
  }
  if (facts.dataQuality.estimated) dq.push('some spend estimated at list rates');
  if (dq.length) parts.push(`Data quality: ${dq.join(', ')}.`);

  return parts.join(' ');
}
