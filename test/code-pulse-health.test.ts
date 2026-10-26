// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';
import { seedUserSql } from './helpers/seed';

let sql: TestSql;
let cleanup: () => Promise<void>;
let getCodePulseHealth: typeof import('@/lib/pulse/code/health').getCodePulseHealth;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 24 * 60 * 60;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const mod = await import('@/lib/pulse/code/health');
  getCodePulseHealth = mod.getCodePulseHealth;

  await seedUserSql(sql, 'user-1');
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`DELETE FROM code_assistant_meta;
           DELETE FROM code_session_stats;
           DELETE FROM code_otel_metrics;
           DELETE FROM config WHERE key IN ('code_aggregator_last_run', 'code_model_rates');`);
});

async function seedStats(sessionId: string, modelsJson: string, opts: { userId?: string; computedAt?: number } = {}) {
  await sql.run(
    `INSERT INTO code_session_stats
       (session_id, user_id, repo, git_branch, first_at, last_at, models_json, computed_at)
     VALUES (?, ?, 'my-app', 'main', ?, ?, ?, ?)`,
    [sessionId, opts.userId ?? 'user-1', NOW, NOW, modelsJson, opts.computedAt ?? NOW],
  );
}

async function seedMeta(id: string, sessionId: string, opts: { model?: string; occurredAt?: number } = {}) {
  await sql.run(
    `INSERT INTO code_assistant_meta
       (id, user_id, session_id, model, occurred_at, ingested_at)
     VALUES (?, 'user-1', ?, ?, ?, ?)`,
    [id, sessionId, opts.model ?? 'claude-haiku-4-5', opts.occurredAt ?? NOW, NOW],
  );
}

async function seedOtelMetric(id: string, opts: { userId?: string | null; occurredAt?: number } = {}) {
  await sql.run(
    `INSERT INTO code_otel_metrics (id, user_id, session_id, metric_name, value, occurred_at)
     VALUES (?, ?, 's-otel', 'claude_code.active_time.total', 60, ?)`,
    [id, opts.userId ?? null, opts.occurredAt ?? NOW],
  );
}

describe('getCodePulseHealth', () => {
  it('detects an unpriced model with session + token counts', async () => {
    await seedMeta('m-unpriced', 's-unpriced', { model: 'made-up-model-9' });
    await seedStats('s-unpriced', JSON.stringify({
      'made-up-model-9': { input: 1000, output: 500, cache_creation: 0, cache_read: 0 },
    }));

    const health = await getCodePulseHealth();
    const entry = health.unpricedModels.find(m => m.model === 'made-up-model-9');
    expect(entry).toBeDefined();
    expect(entry!.sessions).toBe(1);
    expect(entry!.totalTokens).toBe(1500);
  });

  it('detects a Bedrock-decorated model priced only via normalizeModelId fallback as estimated', async () => {
    await seedMeta('m-est', 's-est', { model: 'us.anthropic.claude-opus-4-6-v1' });
    await seedStats('s-est', JSON.stringify({
      'us.anthropic.claude-opus-4-6-v1': { input: 100, output: 50, cache_creation: 0, cache_read: 0 },
    }));

    const health = await getCodePulseHealth();
    const entry = health.estimatedModels.find(m => m.model === 'us.anthropic.claude-opus-4-6-v1');
    expect(entry).toBeDefined();
    expect(entry!.sessions).toBe(1);
    // Must NOT also appear as unpriced — it prices fine via normalisation.
    expect(health.unpricedModels.find(m => m.model === 'us.anthropic.claude-opus-4-6-v1')).toBeUndefined();
  });

  it('does not flag a fully known model as unpriced or estimated', async () => {
    await seedMeta('m-known', 's-known', { model: 'claude-haiku-4-5' });
    await seedStats('s-known', JSON.stringify({
      'claude-haiku-4-5': { input: 100, output: 50, cache_creation: 0, cache_read: 0 },
    }));

    const health = await getCodePulseHealth();
    expect(health.unpricedModels.find(m => m.model === 'claude-haiku-4-5')).toBeUndefined();
    expect(health.estimatedModels.find(m => m.model === 'claude-haiku-4-5')).toBeUndefined();
  });

  it('counts orphan sessions — code_assistant_meta session_ids missing from code_session_stats', async () => {
    await seedMeta('m-orphan', 's-orphan', {});
    // No corresponding code_session_stats row inserted for s-orphan.

    const health = await getCodePulseHealth();
    expect(health.orphanSessions).toBe(1);
  });

  it('does not count a session as orphaned once it has a stats row', async () => {
    await seedMeta('m-ok', 's-ok', {});
    await seedStats('s-ok', '{}');

    const health = await getCodePulseHealth();
    expect(health.orphanSessions).toBe(0);
  });

  it('excludes meta rows ingested after the aggregator last-run cutoff (transient, not orphaned)', async () => {
    // codeAggregatorLastRun is set to a point BEFORE this meta row's
    // ingested_at (NOW, via seedMeta) — the aggregator simply hasn't had a
    // chance to roll it up yet, so it should not count as a pipeline orphan.
    await sql.run(`INSERT INTO config (key, value) VALUES ('code_aggregator_last_run', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [new Date((NOW - 100) * 1000).toISOString()]);
    await seedMeta('m-transient', 's-transient', {});

    const health = await getCodePulseHealth();
    expect(health.orphanSessions).toBe(0);
  });

  it('still counts a meta row ingested before the aggregator last-run cutoff as orphaned', async () => {
    await sql.run(`INSERT INTO config (key, value) VALUES ('code_aggregator_last_run', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [new Date((NOW + 100) * 1000).toISOString()]);
    await seedMeta('m-real-orphan', 's-real-orphan', {});

    const health = await getCodePulseHealth();
    expect(health.orphanSessions).toBe(1);
  });

  it('counts malformed models_json rows', async () => {
    await seedStats('s-broken', '{broken');

    const health = await getCodePulseHealth();
    expect(health.malformedModelsJson).toBe(1);
  });

  it('does not count null/empty models_json as malformed', async () => {
    await seedStats('s-null', null as unknown as string);

    const health = await getCodePulseHealth();
    expect(health.malformedModelsJson).toBe(0);
  });

  it('counts unattributed OTel rows (user_id IS NULL) in the last 30 days', async () => {
    await seedOtelMetric('otel-1', { userId: null });
    await seedOtelMetric('otel-2', { userId: null });
    await seedOtelMetric('otel-3', { userId: 'user-1' });

    const health = await getCodePulseHealth();
    expect(health.unattributedOtel.rows).toBe(2);
  });

  it('excludes OTel rows older than 30 days from unattributed count', async () => {
    await seedOtelMetric('otel-old', { userId: null, occurredAt: NOW - 40 * DAY });

    const health = await getCodePulseHealth();
    expect(health.unattributedOtel.rows).toBe(0);
  });

  it('reports distinctEmails as 0 (code_otel_metrics has no email column)', async () => {
    await seedOtelMetric('otel-1', { userId: null });

    const health = await getCodePulseHealth();
    expect(health.unattributedOtel.distinctEmails).toBe(0);
  });

  it('reads aggregatorLastRun from config, null when unset', async () => {
    expect((await getCodePulseHealth()).aggregatorLastRun).toBeNull();

    const iso = new Date().toISOString();
    await sql.run(`INSERT INTO config (key, value) VALUES ('code_aggregator_last_run', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [iso]);
    expect((await getCodePulseHealth()).aggregatorLastRun).toBe(iso);
  });

  it('reports lastOtelIngest as MAX(occurred_at) or null when empty', async () => {
    expect((await getCodePulseHealth()).lastOtelIngest).toBeNull();
    await seedOtelMetric('otel-1', { occurredAt: NOW - 100 });
    await seedOtelMetric('otel-2', { occurredAt: NOW });
    expect((await getCodePulseHealth()).lastOtelIngest).toBe(NOW);
  });

  it('reports lastMetaIngest as MAX(ingested_at) or null when empty', async () => {
    expect((await getCodePulseHealth()).lastMetaIngest).toBeNull();
    await seedMeta('m1', 's1', {});
    const row = await getCodePulseHealth();
    expect(row.lastMetaIngest).not.toBeNull();
  });

  it('returns all-clear health with no data seeded', async () => {
    const health = await getCodePulseHealth();
    expect(health.unpricedModels).toEqual([]);
    expect(health.estimatedModels).toEqual([]);
    expect(health.unattributedOtel).toEqual({ rows: 0, distinctEmails: 0 });
    expect(health.orphanSessions).toBe(0);
    expect(health.malformedModelsJson).toBe(0);
  });
});
