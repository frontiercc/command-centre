// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';
import { seedUserSql } from './helpers/seed';

let sql: TestSql;
let cleanup: () => Promise<void>;
let buildModelEfficiency: typeof import('@/lib/finance/model-efficiency').buildModelEfficiency;
let MIN_SPEND: number;

const NOW = Math.floor(Date.parse('2026-07-20T00:00:00Z') / 1000);
const OCCURRED_AT = Math.floor(Date.UTC(2026, 6, 10) / 1000); // inside July 2026

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const mod = await import('@/lib/finance/model-efficiency');
  buildModelEfficiency = mod.buildModelEfficiency;
  MIN_SPEND = mod.MIN_SPEND;

  await seedUserSql(sql, 'user-1');
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`DELETE FROM code_assistant_meta;
           DELETE FROM code_session_classifications;
           DELETE FROM code_session_stats;`);
});

/** Insert a code_session_stats row (required before a classifications row — FK). */
async function seedSessionStats(opts: {
  sessionId: string;
  toolUseCount: number;
  errorCount: number;
}) {
  await sql.run(
    `INSERT INTO code_session_stats
       (session_id, user_id, first_at, last_at, tool_use_count, error_count, computed_at)
     VALUES (?, 'user-1', ?, ?, ?, ?, ?)`,
    [opts.sessionId, OCCURRED_AT, OCCURRED_AT, opts.toolUseCount, opts.errorCount, NOW],
  );
}

async function seedClassification(sessionId: string, workType: string) {
  await sql.run(
    `INSERT INTO code_session_classifications
       (session_id, user_id, work_type, tier, confidence, classifier_model, classified_at)
     VALUES (?, 'user-1', ?, 1, 0.9, 'haiku', ?)`,
    [sessionId, workType, NOW],
  );
}

async function seedMeta(opts: {
  id: string;
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}) {
  await sql.run(
    `INSERT INTO code_assistant_meta
       (id, user_id, session_id, model, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens, tool_use_count, error_count,
        occurred_at, ingested_at)
     VALUES (?, 'user-1', ?, ?, ?, ?, 0, 0, 1, 0, ?, ?)`,
    [opts.id, opts.sessionId, opts.model, opts.inputTokens, opts.outputTokens, OCCURRED_AT, NOW],
  );
}

describe('buildModelEfficiency (code)', () => {
  it('groups by work_type × model and flags a high-Opus low-friction activity', async () => {
    // 6 "documentation" sessions: 4 opus-heavy, 2 sonnet — opus is ~77% of
    // spend, low friction (5/100 tool-use per session).
    for (let i = 0; i < 4; i++) {
      const sessionId = `doc-opus-${i}`;
      await seedSessionStats({ sessionId, toolUseCount: 100, errorCount: 5 });
      await seedClassification(sessionId, 'documentation');
      await seedMeta({
        id: `m-doc-opus-${i}`,
        sessionId,
        model: 'claude-opus-4-8',
        inputTokens: 500_000,
        outputTokens: 500_000,
      });
    }
    for (let i = 0; i < 2; i++) {
      const sessionId = `doc-sonnet-${i}`;
      await seedSessionStats({ sessionId, toolUseCount: 100, errorCount: 5 });
      await seedClassification(sessionId, 'documentation');
      await seedMeta({
        id: `m-doc-sonnet-${i}`,
        sessionId,
        model: 'claude-sonnet-4-6',
        inputTokens: 500_000,
        outputTokens: 500_000,
      });
    }

    // 2 "infrastructure" sessions — below MIN_SESSIONS (5), never flagged.
    for (let i = 0; i < 2; i++) {
      const sessionId = `infra-${i}`;
      await seedSessionStats({ sessionId, toolUseCount: 50, errorCount: 1 });
      await seedClassification(sessionId, 'infrastructure');
      await seedMeta({
        id: `m-infra-${i}`,
        sessionId,
        model: 'claude-sonnet-4-6',
        inputTokens: 200_000,
        outputTokens: 200_000,
      });
    }

    const r = await buildModelEfficiency('code', '2026-07', NOW);

    expect(r.surface).toBe('code');
    expect(r.hasData).toBe(true);
    expect(r.period.start).toBe(Math.floor(Date.UTC(2026, 6, 1) / 1000));
    expect(r.period.end).toBe(Math.floor(Date.UTC(2026, 7, 1) / 1000));

    const doc = r.activities.find((a) => a.key === 'documentation')!;
    expect(doc).toBeDefined();
    expect(doc.byModel.length).toBeGreaterThan(1);
    // opus: 1M tokens * ($5 in + $25 out)/2 per session... verify via totals instead of hardcoding
    expect(doc.totalSpendUsd).toBeGreaterThan(MIN_SPEND);
    expect(doc.flag).toBeDefined();
    expect(doc.flag?.premiumModel).toContain('opus');
    expect(doc.flag?.premiumShare).toBeGreaterThanOrEqual(0.4);
    expect(doc.flag?.targetModel).toContain('sonnet');
    expect(doc.flag?.estCeilingUsd).toBeGreaterThan(0);
    expect(doc.flag?.suppressedReason).toBeUndefined();
    expect(doc.friction).toBeCloseTo(0.05, 5);

    const infra = r.activities.find((a) => a.key === 'infrastructure');
    expect(infra).toBeDefined();
    expect(infra?.flag).toBeUndefined();
    expect(r.belowVolume.some((b) => b.key === 'infrastructure')).toBe(true);

    // Global model order — most-expensive-first across ALL activities
    // (not per-activity tier rank), used by the UI to assign one stable
    // colour per model.
    expect(r.modelOrder).toContain('claude-opus-4-8');
    expect(r.modelOrder).toContain('claude-sonnet-4-6');
    const opusIdx = r.modelOrder.indexOf('claude-opus-4-8');
    const sonnetIdx = r.modelOrder.indexOf('claude-sonnet-4-6');
    expect(opusIdx).toBeLessThan(sonnetIdx);

    // Reconciliation invariant, pinned on the BUILT report (not just the pure
    // computeCostByType helper): the five costByType terms must sum to the
    // priced-only spendByModel total AND to totals.spendUsd -- on Code both
    // hold, because Code's measured spend IS the token-priced figure (unlike
    // Cowork, where totals.spendUsd can also include unpriced/null-model
    // cost_usd).
    const costByTypeSum =
      r.costByType.inputUsd + r.costByType.outputUsd + r.costByType.cacheWriteUsd + r.costByType.cacheReadUsd + r.costByType.unclassifiedUsd;
    const pricedSpendSum = r.spendByModel.reduce((s, m) => s + m.spendUsd, 0);
    expect(costByTypeSum).toBeCloseTo(pricedSpendSum, 5);
    expect(costByTypeSum).toBeCloseTo(r.totals.spendUsd, 5);
  });

  it('excludes an unpriced model from spend/tokens but records it in unpricedModels', async () => {
    const sessionId = 'unpriced-1';
    await seedSessionStats({ sessionId, toolUseCount: 10, errorCount: 0 });
    await seedClassification(sessionId, 'testing');
    await seedMeta({
      id: 'm-unpriced-1',
      sessionId,
      model: 'mystery-model-9000',
      inputTokens: 100_000,
      outputTokens: 100_000,
    });

    const r = await buildModelEfficiency('code', '2026-07', NOW);

    expect(r.unpricedModels).toContain('mystery-model-9000');
    const testingActivity = r.activities.find((a) => a.key === 'testing')!;
    expect(testingActivity).toBeDefined();
    expect(testingActivity.totalSpendUsd).toBe(0);
    expect(testingActivity.tokens).toBe(0);
    expect(testingActivity.byModel).toHaveLength(0);
    expect(r.modelOrder).not.toContain('mystery-model-9000');
  });
});
