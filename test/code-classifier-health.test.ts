// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Classifier-health data layer tests, run on Postgres (the shared
// test server when CCC_TEST_PG_URL is set, else a testcontainer), following
// the runSpec() pattern in test/code-classifier-route-pg.test.ts (the
// harness for this same feature area).
//
// Seed note: code_session_classifications.session_id carries a real FK to
// code_session_stats(session_id) (migration 029, schema.pg.ts), so this file seeds code_session_stats first for
// every session_id used (same fix test/code-classifier-route-pg.test.ts
// applies).
//
// This file runs one runSpec() (matching the house pattern) and clears the
// two tables between scenarios so each assertion sees exactly the rows its
// numbers assume, with one DB/client per run.
import { describe, it, expect } from 'vitest';

const NOW = Math.floor(Date.now() / 1000);

interface ClassificationSeed {
  session_id: string;
  status: string;
  tier: number;
  confidence: number;
  error?: string | null;
  classified_at?: number;
  user_id?: string | null;
}

async function runSpec(): Promise<void> {
  const h = await (await import('./helpers/db')).createTestDbClient('postgres');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = h.client;
  const cleanup = h.cleanup;
  try {
    const { schema } = await import('@/lib/db/schema');
    const {
      getClassifierHealth,
      getTierDistribution,
      getConfidenceHistogram,
      getCurrentFailures,
    } = await import('@/lib/pulse/code/classifier-health');

    async function seedSession(session_id: string, user_id: string | null = 'u1') {
      await client.insert(schema.codeSessionStats).values({
        session_id, user_id, first_at: NOW, last_at: NOW, computed_at: NOW,
      });
    }

    async function seedClassification(opts: ClassificationSeed) {
      await seedSession(opts.session_id, opts.user_id ?? 'u1');
      await client.insert(schema.codeSessionClassifications).values({
        session_id: opts.session_id,
        user_id: opts.user_id ?? 'u1',
        work_type: 'feature',
        tier: opts.tier,
        confidence: opts.confidence,
        classifier_model: 'claude-haiku-4-5-20251001',
        status: opts.status,
        error: opts.error ?? null,
        classified_at: opts.classified_at ?? NOW,
        provisional: 0,
      });
    }

    // Child rows reference the parent by FK — clear child first, then parent.
    async function clearAll() {
      await client.delete(schema.codeSessionClassifications);
      await client.delete(schema.codeSessionStats);
    }

    // ── tier distribution counts classified rows per tier ──────────────────
    await seedClassification({ session_id: 'a', status: 'classified', tier: 1, confidence: 0.9 });
    await seedClassification({ session_id: 'b', status: 'classified', tier: 3, confidence: 0.5 });
    await seedClassification({ session_id: 'c', status: 'classified', tier: 3, confidence: 1.0 });
    const d = await getTierDistribution();
    expect(d).toEqual({ tier1: 1, tier2: 0, tier3: 2 });
    await clearAll();

    // ── confidence histogram buckets by 0.1, with 1.0 in the top bucket ─────
    await seedClassification({ session_id: 'a', status: 'classified', tier: 1, confidence: 0.0 });
    await seedClassification({ session_id: 'b', status: 'classified', tier: 1, confidence: 0.95 });
    await seedClassification({ session_id: 'c', status: 'classified', tier: 1, confidence: 1.0 });
    const h = await getConfidenceHistogram();
    expect(h).toHaveLength(11);
    expect(h[0]).toBe(1);   // 0.0
    expect(h[9]).toBe(1);   // 0.95 → [0.9,1.0)
    expect(h[10]).toBe(1);  // 1.0 → top bucket
    await clearAll();

    // ── current failures returns only status=failed rows, newest first ─────
    await seedClassification({ session_id: 'ok', status: 'classified', tier: 1, confidence: 0.9 });
    await seedClassification({ session_id: 'f1', status: 'failed', tier: 1, confidence: 0, error: 'boom', classified_at: 100 });
    await seedClassification({ session_id: 'f2', status: 'failed', tier: 1, confidence: 0, error: 'bang', classified_at: 200 });
    const f = await getCurrentFailures(10);
    expect(f.map(r => r.session_id)).toEqual(['f2', 'f1']);
    await clearAll();

    // ── getClassifierHealth aggregates classified/failed + surfaces queue ──
    await seedClassification({ session_id: 'h1', status: 'classified', tier: 1, confidence: 0.9 });
    await seedClassification({ session_id: 'h2', status: 'failed', tier: 1, confidence: 0, error: 'oops' });
    const health = await getClassifierHealth(NOW);
    expect(health.classified).toBe(1);
    expect(health.failed).toBe(1);
    expect(health.model).toBe('claude-haiku-4-5-20251001'); // default, unset config
    expect(health.enabled).toBe(true); // default, unset config
    expect(health.lastRunAt).toBeNull();
    expect(health.queue).toEqual({ final: 0, provisional: 0, finalise: 0, total: 0 });
  } finally {
    await cleanup();
  }
}

describe('classifier-health aggregates (postgres)', () => {
  it('tier distribution, confidence histogram, current failures, and health on real postgres', async () => {
    await runSpec();
  }, 180_000);
});
