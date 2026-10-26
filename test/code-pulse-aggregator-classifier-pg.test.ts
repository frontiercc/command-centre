// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres coverage for lib/pulse/code/aggregator.ts,
// lib/pulse/code/classifier.ts, and lib/pulse/code/health.ts, run against a
// migrated Postgres database (the shared test server when CCC_TEST_PG_URL is
// set, else a testcontainer).
//
// HARNESS RULE (copied from test/pulse-cowork-aggregator-classifier-pg.test.ts):
// these modules import `schema` from lib/db/schema.ts, and the database client binds to DATABASE_URL on
// first use, so the modules-under-test (and schema) are DYNAMIC-imported
// AFTER createTestDbClient() has set DATABASE_URL + reset modules.
//
// Coverage:
//   1. the aggregator produces the expected code_metrics ROLLING AND WEEK
//      rows for a seeded window, proving BOTH the partial-unique-index week
//      upsert (idx_code_metrics_week, WHERE granularity='week') and the
//      plain rolling append work on Postgres.
//   2. token/spend SUMs are correct — code_assistant_meta SUM(input_tokens)/
//      SUM(output_tokens)/SUM(cache_read_tokens) are STRINGS on Postgres
//      (bigint); a missed Number() coercion would silently corrupt the spend
//      figure fed into priceTokens. Asserted via the exact haiku-rate spend
//      (1M in @ $1/MTok + 0.2M out @ $5/MTok + 4M cache-read @ $0.1/MTok =
//      $2.4).
//   3. a classifier write (session digest → code_session_classifications).
//   4. a health readout (pricing coverage + orphan-session count).
//   5. a re-run of the aggregator UPDATES the existing week row (not a
//      duplicate) and APPENDS a fresh rolling row.
import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn();
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: { create: mockCreate },
    })),
    __mockCreate: mockCreate,
  };
});

const NOW = Math.floor(Date.now() / 1000);

async function getMockCreate() {
  const mod = await import('@anthropic-ai/sdk');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mod as any).__mockCreate as ReturnType<typeof vi.fn>;
}

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');

  try {
    // Dynamic import AFTER the env + module reset (harness rule).
    const { schema } = await import('@/lib/db/schema');
    const aggregator = await import('@/lib/pulse/code/aggregator');
    const classifier = await import('@/lib/pulse/code/classifier');
    const health = await import('@/lib/pulse/code/health');
    const config = await import('@/lib/config');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = client as any;

    await db.insert(schema.users).values([{ id: 'user-1', email: 'u1@test.local' }]);

    // ── seed one session: haiku rates $1 in / $5 out / $0.1 cache-read per MTok ──
    await db.insert(schema.codeAssistantMeta).values({
      id: 'm1', user_id: 'user-1', session_id: 's1', model: 'claude-haiku-4-5',
      input_tokens: 1_000_000, output_tokens: 200_000, cache_creation_tokens: 0,
      cache_read_tokens: 4_000_000, tool_use_count: 6, cwd: 'C:\\code\\my-app',
      git_branch: 'main', occurred_at: NOW, ingested_at: NOW,
    });
    await db.insert(schema.coworkMessages).values([
      { id: 'u1', session_id: 's1', user_id: 'user-1', message_type: 'code_user_message', role: 'user', content_preview: 'do', surface: 'code', occurred_at: NOW, ingested_at: NOW },
      { id: 'u2', session_id: 's1', user_id: 'user-1', message_type: 'code_user_message', role: 'user', content_preview: 'do', surface: 'code', occurred_at: NOW, ingested_at: NOW },
      { id: 'u3', session_id: 's1', user_id: 'user-1', message_type: 'code_user_message', role: 'user', content_preview: 'do', surface: 'code', occurred_at: NOW, ingested_at: NOW },
    ]);

    // ── (1)+(2)+(5): aggregator rolling+week code_metrics, Number-coerced spend ──
    await aggregator.runCodeHourlyAggregation();
    await aggregator.runCodeHourlyAggregation(); // second run: rolling APPENDS, weekly UPSERTS

    const statsRows = await db.select().from(schema.codeSessionStats).where(eq(schema.codeSessionStats.session_id, 's1'));
    expect(statsRows[0].user_msg_count).toBe(3);
    expect(Number(statsRows[0].input_tokens)).toBe(1_000_000);

    const orgRows = await db.select().from(schema.codeMetrics).where(eq(schema.codeMetrics.scope_type, 'organisation'));
    const rolling = orgRows.filter((r: { granularity: string }) => r.granularity === 'rolling');
    const weekly = orgRows.filter((r: { granularity: string }) => r.granularity === 'week');
    // code_metrics' unique index is partial (WHERE granularity='week'), so it
    // can never match a 'rolling' row — two runs always append two
    // independent rolling snapshots.
    expect(rolling.length).toBe(2);
    expect(weekly.length).toBe(1); // two runs, same week -> one upserted weekly row (proves no duplicate)

    // spend: 1M x $1/MTok + 0.2M x $5/MTok + 4M x $0.1/MTok = 1 + 1 + 0.4 = 2.4
    // — this is the Number()-coercion-sensitive assertion: a missed coercion
    // of the SUM(input_tokens)/SUM(output_tokens)/SUM(cache_read_tokens)
    // bigint-as-string on Postgres would silently corrupt this figure.
    expect(Number(weekly[0].spend_usd)).toBeCloseTo(2.4, 6);
    expect(Number(rolling[0].spend_usd)).toBeCloseTo(2.4, 6);
    expect(Number(weekly[0].input_tokens)).toBe(1_000_000);
    expect(Number(weekly[0].session_count)).toBe(1);
    expect(Number(weekly[0].autonomy_ratio)).toBeCloseTo(2, 6); // 6 tools / 3 msgs

    // ── (3): classifier writes a session digest classification ─────────────
    await db.insert(schema.codeSessionStats).values({
      session_id: 's-idle', user_id: 'user-1', repo: 'my-app', git_branch: 'main',
      first_at: NOW - 3600, last_at: NOW - 3600, user_msg_count: 2, assistant_turns: 3,
      tool_use_count: 1, error_count: 0, commit_count: 0, input_tokens: 10, output_tokens: 5,
      cache_creation_tokens: 0, cache_read_tokens: 0, models_json: '{}', skills_json: '[]',
      mcp_json: '[]', computed_at: NOW,
    });
    await config.setConfigValue('anthropicAiApiKey', 'sk-test-key');
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify([{ session_id: 's-idle', work_type: 'feature', tier: 2, confidence: 0.8 }]) }],
    });

    const result = await classifier.runCodeClassifierJob();
    expect(result.classified).toBe(1);
    const classRows = await db.select().from(schema.codeSessionClassifications).where(eq(schema.codeSessionClassifications.session_id, 's-idle'));
    expect(classRows[0].work_type).toBe('feature');
    expect(classRows[0].tier).toBe(2);
    expect(classRows[0].provisional).toBe(0);

    // ── (3b) Classifier drain: a failure increments `attempts` on
    // conflict — the ON CONFLICT DO UPDATE path, proven on real Postgres.
    await db.insert(schema.codeSessionStats).values({
      session_id: 's-retry', user_id: 'user-1', repo: 'my-app', git_branch: 'main',
      first_at: NOW - 3 * 3600, last_at: NOW - 3600, user_msg_count: 3, assistant_turns: 5,
      tool_use_count: 0, error_count: 0, commit_count: 0, input_tokens: 0, output_tokens: 0,
      cache_creation_tokens: 0, cache_read_tokens: 0, computed_at: NOW,
    });
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'not valid json' }] });

    await classifier.runCodeClassifierJob();
    let retryRows = await db.select().from(schema.codeSessionClassifications).where(eq(schema.codeSessionClassifications.session_id, 's-retry'));
    expect(retryRows[0].attempts).toBe(1);
    expect(retryRows[0].status).toBe('failed');

    await classifier.runCodeClassifierJob(); // same session fails again — proves ON CONFLICT DO UPDATE, not a fresh insert
    retryRows = await db.select().from(schema.codeSessionClassifications).where(eq(schema.codeSessionClassifications.session_id, 's-retry'));
    expect(retryRows[0].attempts).toBe(2);
    expect(retryRows[0].status).toBe('failed');

    // ── (4): health readout — haiku is priced, no orphan sessions ───────────
    const h = await health.getCodePulseHealth();
    expect(h.unpricedModels).toEqual([]);
    expect(h.orphanSessions).toBe(0);
  } finally {
    await cleanup();
  }
}

describe('Developer Pulse aggregator + classifier + health (postgres)', () => {
  it(
    'rolling/week code_metrics writes, token/spend SUM coercion, classifier write, and health readout behave correctly on postgres',
    async () => {
      await runSpec();
    },
    180_000,
  );
});
