// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Audit cycle engine: stratified draw → blind review →
// reweighted scoring. Async Drizzle on Postgres (Number()-coerce aggregate
// reads, Policy B). The scoring maths lives in ./agreement (pure, unit-tested).
import { and, eq, gte, lt, isNotNull, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { computeStratum, confidenceBand, isOversampledBand, mulberry32 } from './strata';
import { reweightedAgreement, quadraticWeightedKappa, confusionMatrix, type AuditItem, type TierPair } from './agreement';

/** Oversample multiplier applied to hard/rare bands when allocating the sample. */
const OVERSAMPLE_FACTOR = 2;

interface Candidate {
  classificationId: number;
  tier: number;
  confidence: number | null;
  model: string | null;
  stratum: string;
}

/** Half-open [start, end) epoch-second range for a 'YYYY-MM' period (UTC). */
export function monthRangeUtc(period: string): [number, number] {
  const [y, m] = period.split('-').map(Number);
  const start = Math.floor(Date.UTC(y, m - 1, 1) / 1000);
  const end = Math.floor(Date.UTC(y, m, 1) / 1000);
  return [start, end];
}

/** Fisher–Yates shuffle in place using a seeded PRNG. */
function shuffle<T>(arr: T[], rand: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Deterministically allocate `size` picks across strata: oversample the hard
 * bands, then largest-remainder rounding to hit the target exactly. Each
 * stratum's own list is seeded-shuffled so the SAME seed yields the SAME draw.
 */
function stratifiedDraw(candidates: Candidate[], size: number, seed: number): Candidate[] {
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const g = groups.get(c.stratum) ?? [];
    g.push(c);
    groups.set(c.stratum, g);
  }

  const rand = mulberry32(seed);
  // Stable stratum order (so allocation is deterministic), then shuffle within.
  const strata = [...groups.keys()].sort();
  for (const s of strata) shuffle(groups.get(s)!, rand);

  const total = candidates.length;
  const target = Math.min(size, total);

  // Weight = availability × oversample multiplier for hard bands.
  const weight = (s: string) => {
    const n = groups.get(s)!.length;
    const bandKey = s.split(':')[1] as ReturnType<typeof confidenceBand>;
    return n * (isOversampledBand(bandKey) ? OVERSAMPLE_FACTOR : 1);
  };
  const weightSum = strata.reduce((a, s) => a + weight(s), 0);

  // Floor quota + fractional remainder, capped at availability.
  const raw = strata.map(s => ({ s, exact: (target * weight(s)) / weightSum }));
  const quota = new Map<string, number>();
  let allocated = 0;
  for (const { s, exact } of raw) {
    const q = Math.min(groups.get(s)!.length, Math.floor(exact));
    quota.set(s, q);
    allocated += q;
  }
  // Distribute the remainder by largest fractional part (ties broken by stratum order).
  const remainders = raw
    .map(({ s, exact }) => ({ s, frac: exact - Math.floor(exact), room: groups.get(s)!.length - quota.get(s)! }))
    .filter(r => r.room > 0)
    .sort((a, b) => b.frac - a.frac || (a.s < b.s ? -1 : 1));
  let remaining = target - allocated;
  for (const r of remainders) {
    if (remaining <= 0) break;
    quota.set(r.s, quota.get(r.s)! + 1);
    remaining--;
  }

  const picked: Candidate[] = [];
  for (const s of strata) picked.push(...groups.get(s)!.slice(0, quota.get(s)!));
  return picked;
}

/**
 * Draw a monthly audit sample for a surface (cowork only for now; code may
 * follow). Stores the production stratum weights so the headline agreement can
 * be reweighted at scoring time. Returns the new cycle id + sample size.
 */
export async function drawAuditSample(opts: {
  period: string;
  surface?: string;
  seed: number;
  size?: number;
  now?: number;
}): Promise<{ cycleId: number; nSampled: number }> {
  const surface = opts.surface ?? 'cowork';
  const size = opts.size ?? 50;
  const nowS = opts.now ?? Math.floor(Date.now() / 1000);
  const [start, end] = monthRangeUtc(opts.period);

  const client = await getTypedClient();
  const pc = schema.pulseClassifications;
  const cm = schema.coworkMessages;

  const rows = await client
    .select({ id: pc.id, tier: pc.tier, confidence: pc.classifier_confidence, model: pc.classifier_model })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .where(and(
      eq(pc.classifier_status, 'classified'),
      eq(cm.surface, surface),
      gte(cm.occurred_at, start),
      lt(cm.occurred_at, end),
    ));

  const candidates: Candidate[] = rows.map(r => ({
    classificationId: Number(r.id),
    tier: Number(r.tier),
    confidence: r.confidence === null || r.confidence === undefined ? null : Number(r.confidence),
    model: r.model ?? null,
    stratum: computeStratum(Number(r.tier), r.confidence === null || r.confidence === undefined ? null : Number(r.confidence)),
  }));

  // Production weights = share of each stratum among ALL in-period rows.
  const stratumCounts = new Map<string, number>();
  for (const c of candidates) stratumCounts.set(c.stratum, (stratumCounts.get(c.stratum) ?? 0) + 1);
  const totalInPeriod = candidates.length || 1;
  const weights: Record<string, number> = {};
  for (const [s, n] of stratumCounts) weights[s] = n / totalInPeriod;

  const picked = stratifiedDraw(candidates, size, opts.seed);
  const model = picked[0]?.model ?? candidates[0]?.model ?? null;

  const inserted = await client
    .insert(schema.pulseAuditCycles)
    .values({
      period: opts.period,
      surface,
      sample_seed: opts.seed,
      classifier_model: model,
      rubric_version: null,
      stratum_weights: JSON.stringify(weights),
      status: 'open',
      n_sampled: picked.length,
      n_reviewed: 0,
      created_at: nowS,
    })
    .returning({ id: schema.pulseAuditCycles.id });
  const cycleId = Number(inserted[0].id);

  if (picked.length > 0) {
    await client.insert(schema.pulseAuditItems).values(picked.map(c => ({
      cycle_id: cycleId,
      classification_id: c.classificationId,
      stratum: c.stratum,
      model_tier: c.tier,
      model_confidence: c.confidence,
    })));
  }

  return { cycleId, nSampled: picked.length };
}

/**
 * The published headline: the n-weighted aggregate of the last 3 scored
 * cycles for a surface (~a rolling quarter). Each cycle's agreement is already
 * reweighted to its own production mix, so we pool them weighted by reviewed
 * count. Returns null when no cycle has been scored yet.
 */
export async function getPublishedAgreement(
  surface = 'cowork',
): Promise<{ agreementPct: number; kappa: number; n: number; cycles: number } | null> {
  const client = await getTypedClient();
  const c = schema.pulseAuditCycles;
  const rows = await client
    .select({ agreement_pct: c.agreement_pct, kappa: c.kappa, n_reviewed: c.n_reviewed })
    .from(c)
    .where(and(eq(c.surface, surface), eq(c.status, 'scored')))
    .orderBy(sql`${c.scored_at} DESC`)
    .limit(3);

  if (rows.length === 0) return null;

  let n = 0;
  let aAcc = 0;
  let kAcc = 0;
  for (const r of rows) {
    const nr = Number(r.n_reviewed);
    n += nr;
    aAcc += Number(r.agreement_pct ?? 0) * nr;
    kAcc += Number(r.kappa ?? 0) * nr;
  }
  if (n === 0) return null;
  return { agreementPct: aAcc / n, kappa: kAcc / n, n, cycles: rows.length };
}

/**
 * Monthly automation: draw the prior calendar month's audit cycle for a surface,
 * unless one already exists for that period (idempotent — safe to call every
 * scheduler cycle). Seed is period-derived so the draw is reproducible.
 */
export async function runAuditDrawJob(now?: number, surface = 'cowork'): Promise<{ drawn: boolean; period?: string }> {
  const nowS = now ?? Math.floor(Date.now() / 1000);
  const d = new Date(nowS * 1000);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  const period = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

  const client = await getTypedClient();
  const c = schema.pulseAuditCycles;
  const existing = await client
    .select({ id: c.id })
    .from(c)
    .where(and(eq(c.surface, surface), eq(c.period, period)))
    .limit(1);
  if (existing.length > 0) return { drawn: false };

  const seed = Number(period.replace('-', ''));
  await drawAuditSample({ period, surface, seed, size: 50, now: nowS });
  return { drawn: true, period };
}

/** Record a blind human review on one item; `agrees` is derived from the tiers. */
export async function recordReview(
  itemId: number,
  humanTier: number,
  humanTaskType: string | null,
  reviewedBy: string,
  now?: number,
): Promise<void> {
  const client = await getTypedClient();
  const rows = await client
    .select({ model_tier: schema.pulseAuditItems.model_tier })
    .from(schema.pulseAuditItems)
    .where(eq(schema.pulseAuditItems.id, itemId))
    .limit(1);
  if (rows.length === 0) return;
  const agrees = Number(rows[0].model_tier) === humanTier ? 1 : 0;
  await client
    .update(schema.pulseAuditItems)
    .set({
      human_tier: humanTier,
      human_task_type: humanTaskType,
      reviewed_by: reviewedBy,
      reviewed_at: now ?? Math.floor(Date.now() / 1000),
      agrees,
    })
    .where(eq(schema.pulseAuditItems.id, itemId));
}

/**
 * Score a cycle from its reviewed items: reweighted agreement, quadratic-
 * weighted kappa, and a confusion matrix. Writes the results and marks the
 * cycle scored. Returns null if nothing has been reviewed yet.
 */
export async function scoreAuditCycle(cycleId: number, now?: number): Promise<{ agreementPct: number; kappa: number; nReviewed: number } | null> {
  const client = await getTypedClient();

  const cycleRows = await client
    .select({ stratum_weights: schema.pulseAuditCycles.stratum_weights })
    .from(schema.pulseAuditCycles)
    .where(eq(schema.pulseAuditCycles.id, cycleId))
    .limit(1);
  if (cycleRows.length === 0) return null;
  const weights = JSON.parse(cycleRows[0].stratum_weights ?? '{}') as Record<string, number>;

  const reviewed = await client
    .select({ stratum: schema.pulseAuditItems.stratum, model_tier: schema.pulseAuditItems.model_tier, human_tier: schema.pulseAuditItems.human_tier, agrees: schema.pulseAuditItems.agrees })
    .from(schema.pulseAuditItems)
    .where(and(eq(schema.pulseAuditItems.cycle_id, cycleId), isNotNull(schema.pulseAuditItems.human_tier)));

  if (reviewed.length === 0) return null;

  const items: AuditItem[] = reviewed.map(r => ({ stratum: r.stratum, agrees: Number(r.agrees) === 1 }));
  const pairs: TierPair[] = reviewed.map(r => ({ human: Number(r.human_tier), model: Number(r.model_tier) }));

  const agreementPct = reweightedAgreement(items, weights);
  const kappa = quadraticWeightedKappa(pairs);
  const confusion = confusionMatrix(pairs);

  await client
    .update(schema.pulseAuditCycles)
    .set({
      status: 'scored',
      n_reviewed: reviewed.length,
      agreement_pct: agreementPct,
      kappa,
      confusion_json: JSON.stringify(confusion),
      scored_at: now ?? Math.floor(Date.now() / 1000),
    })
    .where(eq(schema.pulseAuditCycles.id, cycleId));

  return { agreementPct, kappa, nReviewed: reviewed.length };
}
