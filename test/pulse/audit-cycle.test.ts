// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Audit cycle engine (§2): stratified draw → blind review → reweighted scoring.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { TestSql } from '../helpers/sql';
import { createTestDatabase } from '../helpers/db';

let sql: TestSql;
let cleanup: () => Promise<void>;
let mod: typeof import('@/lib/pulse/audit/cycle');
let strata: typeof import('@/lib/pulse/audit/strata');

const MONTH = '2026-06';
const JUN = Math.floor(Date.UTC(2026, 5, 15) / 1000); // mid-June, in-period
const NOW = Math.floor(Date.UTC(2026, 6, 2) / 1000);   // early July (period is prior month)

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql; cleanup = t.cleanup;
  mod = await import('@/lib/pulse/audit/cycle');
  strata = await import('@/lib/pulse/audit/strata');
});
afterAll(async () => cleanup());
beforeEach(async () => {
  await sql.exec(`DELETE FROM pulse_audit_items; DELETE FROM pulse_audit_cycles; DELETE FROM pulse_classifications; DELETE FROM cowork_messages;`);
});

let seq = 0;
async function seedClassified(tier: number, confidence: number, occurredAt = JUN, surface = 'cowork') {
  await sql.run(`INSERT INTO users (id, email) VALUES ('u1', 'u1@test.local') ON CONFLICT DO NOTHING`);
  const mid = `m-${++seq}`;
  await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, surface, message_type, role, content_preview, occurred_at, ingested_at)
              VALUES (?, 's', 'u1', ?, 'cowork_user_message', 'user', 'do the thing', ?, ?)`, [mid, surface, occurredAt, occurredAt]);
  await sql.run(`INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classifier_status, classified_at)
              VALUES (?, 'u1', ?, 'general', ?, 'haiku', 'classified', ?)`, [mid, tier, confidence, occurredAt]);
}

async function insertScoredCycle(period: string, agreement: number, kappa: number, nReviewed: number, scoredAt: number, surface = 'cowork') {
  await sql.run(`INSERT INTO pulse_audit_cycles (period, surface, sample_seed, status, n_sampled, n_reviewed, agreement_pct, kappa, confusion_json, created_at, scored_at)
              VALUES (?, ?, 1, 'scored', ?, ?, ?, ?, '[]', ?, ?)`, [period, surface, nReviewed, nReviewed, agreement, kappa, scoredAt, scoredAt]);
}

describe('getPublishedAgreement (§2d — rolling three cycles, n-weighted)', () => {
  it('returns null when there are no scored cycles', async () => {
    expect(await mod.getPublishedAgreement('cowork')).toBeNull();
  });

  it('aggregates the last 3 scored cycles, weighted by reviewed count', async () => {
    await insertScoredCycle('2026-04', 0.80, 0.60, 50, 100);
    await insertScoredCycle('2026-05', 0.90, 0.70, 50, 200);
    await insertScoredCycle('2026-06', 1.00, 0.80, 50, 300);
    // A 4th, older cycle must fall outside the rolling window of 3.
    await insertScoredCycle('2026-03', 0.10, 0.10, 50, 50);
    // A different surface must not bleed in.
    await insertScoredCycle('2026-06', 0.50, 0.50, 999, 300, 'code');

    const pub = await mod.getPublishedAgreement('cowork');
    expect(pub).not.toBeNull();
    expect(pub!.n).toBe(150);
    expect(pub!.cycles).toBe(3);
    expect(pub!.agreementPct).toBeCloseTo((0.8 + 0.9 + 1.0) / 3, 5); // equal n → simple mean
    expect(pub!.kappa).toBeCloseTo((0.6 + 0.7 + 0.8) / 3, 5);
  });
});

describe('runAuditDrawJob (monthly automation, idempotent per period)', () => {
  it('draws the prior month once, then skips when a cycle already exists', async () => {
    for (let i = 0; i < 6; i++) await seedClassified(2, 0.6);   // in-period June rows
    for (let i = 0; i < 4; i++) await seedClassified(1, 0.95);

    const first = await mod.runAuditDrawJob(NOW);         // NOW is early July → period 2026-06
    expect(first.drawn).toBe(true);
    expect(first.period).toBe('2026-06');
    expect((await sql.get(`SELECT COUNT(*) c FROM pulse_audit_cycles WHERE period='2026-06'`))).toEqual({ c: 1 });

    const second = await mod.runAuditDrawJob(NOW);         // same month → no duplicate
    expect(second.drawn).toBe(false);
    expect((await sql.get(`SELECT COUNT(*) c FROM pulse_audit_cycles WHERE period='2026-06'`))).toEqual({ c: 1 });
  });
});

describe('strata helpers', () => {
  it('bands confidence into lo/mid/hi with the 0.5–0.8 band as "mid"', () => {
    expect(strata.confidenceBand(0.4)).toBe('lo');
    expect(strata.confidenceBand(0.5)).toBe('mid');
    expect(strata.confidenceBand(0.8)).toBe('mid');
    expect(strata.confidenceBand(0.95)).toBe('hi');
    expect(strata.confidenceBand(null)).toBe('unknown');
  });
  it('composes a tier:band stratum key', () => {
    expect(strata.computeStratum(2, 0.6)).toBe('2:mid');
  });
  it('mulberry32 is deterministic for a given seed', () => {
    const a = strata.mulberry32(42); const b = strata.mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe('drawAuditSample → scoreAuditCycle', () => {
  it('draws a reproducible sample, stores production weights, and scores a reweighted agreement', async () => {
    // 20 classified rows in June across tiers + confidence bands.
    for (let i = 0; i < 8; i++) await seedClassified(1, 0.95);          // tier1 hi (common)
    for (let i = 0; i < 6; i++) await seedClassified(2, 0.6);           // tier2 mid (hard band)
    for (let i = 0; i < 6; i++) await seedClassified(3, 0.9);           // tier3 hi
    // A row OUTSIDE the period must never be sampled.
    await seedClassified(2, 0.6, Math.floor(Date.UTC(2026, 4, 15) / 1000));

    const { cycleId, nSampled } = await mod.drawAuditSample({ period: MONTH, seed: 7, size: 12, now: NOW });
    expect(nSampled).toBeGreaterThan(0);
    expect(nSampled).toBeLessThanOrEqual(12);

    const cycle = (await sql.get('SELECT * FROM pulse_audit_cycles WHERE id = ?', [cycleId])) as Record<string, unknown>;
    expect(cycle.status).toBe('open');
    expect(cycle.period).toBe(MONTH);
    // Production weights are stored and cover only in-period rows (20, not 21).
    const weights = JSON.parse(cycle.stratum_weights as string) as Record<string, number>;
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1.0, 5);
    expect(weights['1:hi']).toBeCloseTo(8 / 20, 5);

    // Reproducibility: same seed → identical set of classification_ids.
    const ids1 = ((await sql.all('SELECT classification_id FROM pulse_audit_items WHERE cycle_id = ? ORDER BY classification_id', [cycleId])) as { classification_id: number }[]).map(r => r.classification_id);
    const { cycleId: cycleId2 } = await mod.drawAuditSample({ period: MONTH, seed: 7, size: 12, now: NOW });
    const ids2 = ((await sql.all('SELECT classification_id FROM pulse_audit_items WHERE cycle_id = ? ORDER BY classification_id', [cycleId2])) as { classification_id: number }[]).map(r => r.classification_id);
    expect(ids2).toEqual(ids1);

    // Blind review: reviewer agrees with all but one item.
    const items = (await sql.all('SELECT id, model_tier FROM pulse_audit_items WHERE cycle_id = ?', [cycleId])) as { id: number; model_tier: number }[];
    for (let i = 0; i < items.length; i++) {
      const human = i === 0 ? (items[i].model_tier === 3 ? 2 : items[i].model_tier + 1) : items[i].model_tier;
      await mod.recordReview(items[i].id, human, 'general', 'admin@x');
    }

    const scored = await mod.scoreAuditCycle(cycleId);
    expect(scored).not.toBeNull();
    expect(scored!.nReviewed).toBe(items.length);
    expect(scored!.agreementPct).toBeGreaterThanOrEqual(0);
    expect(scored!.agreementPct).toBeLessThanOrEqual(1);

    const scoredCycle = (await sql.get('SELECT status, agreement_pct, kappa, confusion_json FROM pulse_audit_cycles WHERE id = ?', [cycleId])) as Record<string, unknown>;
    expect(scoredCycle.status).toBe('scored');
    expect(scoredCycle.agreement_pct).not.toBeNull();
    const confusion = JSON.parse(scoredCycle.confusion_json as string) as number[][];
    const confusionTotal = confusion.flat().reduce((a, b) => a + b, 0);
    expect(confusionTotal).toBe(items.length);
  });
});
