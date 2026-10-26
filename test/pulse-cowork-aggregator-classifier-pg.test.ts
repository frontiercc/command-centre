// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres coverage for lib/pulse/aggregator.ts,
// lib/pulse/classifier.ts, and lib/pulse/cowork/session-aggregator.ts,
// against a migrated Postgres database (createTestDbClient('postgres')).
//
// HARNESS RULE (copied from test/pulse-metrics-events-pg.test.ts): the
// modules-under-test (and schema) are DYNAMIC-imported AFTER
// createTestDbClient() has set the database env + reset modules.
//
// Coverage:
//   1. session-aggregator token SUM from a "model | {json}" row, PLUS a
//      malformed-JSON row in the SAME session, asserting the sum is
//      unaffected (Postgres's `::jsonb` cast throws on invalid JSON; the
//      code sidesteps the SQL-level trap by parsing content_preview in JS
//      instead — this test is the proof).
//   2. A classifier batch write with an ON CONFLICT DO UPDATE path
//      (classifier_attempts incrementing across two runClassifierJob()
//      calls).
//   3. aggregator produces the expected pulse_metrics row (rolling AND
//      upserted weekly) for a seeded window. The Postgres migration's
//      unique index on pulse_metrics(scope_type, scope_id, period_start) is
//      FULL (schema.pg.ts's uniqueIndex has no `.where()`), and
//      writeMetric()'s conflict target must match it (see
//      lib/pulse/aggregator.ts's writeMetric doc comment). Running the
//      weekly upsert for real against Postgres here is what proves it.
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
    // Dynamic import AFTER the database env + module reset (harness rule).
    const { schema } = await import('@/lib/db/schema');
    const sessionAggregator = await import('@/lib/pulse/cowork/session-aggregator');
    const classifier = await import('@/lib/pulse/classifier');
    const aggregator = await import('@/lib/pulse/aggregator');
    const config = await import('@/lib/config');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = client as any;

    await db.insert(schema.users).values([{ id: 'user-1', email: 'u1@test.local' }]);

    // ── (1) session-aggregator: token SUM tolerant of a malformed row ──────
    await db.insert(schema.coworkSessions).values({
      id: 'sess-1', conversation_id: 'conv-1', user_id: 'user-1', started_at: NOW,
    });
    const tokenUsageJson = JSON.stringify({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 5 });
    await db.insert(schema.coworkMessages).values([
      {
        id: 'm1', session_id: 'sess-1', user_id: 'user-1', message_type: 'cowork_api_request',
        surface: 'cowork', source: 'otel', model: 'claude-haiku-4-5',
        cost_usd: '0.02',
        content_preview: `claude-haiku-4-5 | ${tokenUsageJson}`, occurred_at: NOW,
      },
      {
        // Malformed: no " | " separator at all — must not throw, and must
        // not contribute tokens (but its cost_usd IS still summed, since
        // that comes from the real column, not from content_preview parsing).
        id: 'm2', session_id: 'sess-1', user_id: 'user-1', message_type: 'cowork_api_request',
        surface: 'cowork', source: 'otel', model: 'claude-haiku-4-5',
        cost_usd: '0.50',
        content_preview: 'not-a-valid-preview', occurred_at: NOW,
      },
    ]);

    const aggResult = await sessionAggregator.aggregateCoworkSessionStats('sess-1');
    expect(aggResult.errors).toEqual([]);
    expect(aggResult.sessionsUpserted).toBe(1);

    const statsRows = await db.select().from(schema.coworkSessionStats).where(eq(schema.coworkSessionStats.session_id, 'sess-1'));
    const stats = statsRows[0] as { total_input_tokens: number; total_output_tokens: number; total_cost_usd: string | number };
    expect(Number(stats.total_input_tokens)).toBe(100);
    expect(Number(stats.total_output_tokens)).toBe(50);
    expect(Number(stats.total_cost_usd)).toBeCloseTo(0.52, 5);

    // ── (1b) produced_output: 1 / 0 / NULL ────────────────────────────────
    // The NULL case is the one that matters. Retention's strip mode overwrites
    // content_preview, which on a tool_metadata row IS the tool name, so a
    // stripped session cannot be judged either way. Recording 0 there would
    // assert "produced nothing" about a session we cannot read — and on any
    // instance past its retention window that made the whole card read 0.0%.
    const STRIPPED = '[Content removed — retention policy]';
    const outputCases = [
      // [session, tool rows as [name, success], expected produced_output]
      ['sess-out-produced', [['Read', 1], ['Write', 1]], 1],
      ['sess-out-none', [['Read', 1], ['Grep', 1]], 0],
      ['sess-out-edit-only', [['Edit', 1]], 0],
      ['sess-out-failed-write', [['Write', 0]], 0],
      ['sess-out-no-tools', [], 0],
      ['sess-out-stripped', [[STRIPPED, 1]], null],
      // A readable success outranks an unreadable sibling — seeing something
      // produced cannot be undone by a neighbouring row we cannot read.
      ['sess-out-mixed', [[STRIPPED, 1], ['Write', 1]], 1],
    ] as const;

    for (const [sessionId, tools] of outputCases) {
      await db.insert(schema.coworkSessions).values({
        id: sessionId, conversation_id: `conv-${sessionId}`, user_id: 'user-1', started_at: NOW,
      });
      for (let i = 0; i < tools.length; i++) {
        const [toolName, success] = tools[i];
        await db.insert(schema.coworkMessages).values({
          id: `${sessionId}-t${i}`, session_id: sessionId, user_id: 'user-1',
          message_type: 'cowork_tool_metadata', surface: 'cowork', source: 'otel',
          content_preview: toolName, tool_success: success, occurred_at: NOW + i + 1,
        });
      }
      // A session with no events at all is never a candidate, so give the
      // no-tools case one non-tool row to make it aggregatable.
      if (tools.length === 0) {
        await db.insert(schema.coworkMessages).values({
          id: `${sessionId}-u0`, session_id: sessionId, user_id: 'user-1',
          message_type: 'cowork_user_message', surface: 'cowork', source: 'otel',
          content_preview: 'no tools here', occurred_at: NOW,
        });
      }
    }

    for (const [sessionId, , expected] of outputCases) {
      const r = await sessionAggregator.aggregateCoworkSessionStats(sessionId);
      expect(r.errors, `${sessionId} aggregated without error`).toEqual([]);
      const row = (await db.select().from(schema.coworkSessionStats)
        .where(eq(schema.coworkSessionStats.session_id, sessionId)))[0] as { produced_output: number | string | null };
      const actual = row.produced_output === null ? null : Number(row.produced_output);
      expect(actual, `${sessionId} produced_output`).toBe(expected);
    }

    // ── (2) classifier: ON CONFLICT DO UPDATE increments classifier_attempts ─
    await config.setConfigValue('anthropicAiApiKey', 'sk-test-key');
    await config.setConfigValue('pulseClassifierModel', 'claude-haiku-4-5-20251001');
    const mockCreate = await getMockCreate();
    mockCreate.mockRejectedValue(new Error('Network error'));

    await db.insert(schema.coworkMessages).values({
      id: 'cm-1', session_id: 'sess-2', user_id: 'user-1', message_type: 'cowork_user_message',
      surface: 'cowork', content_preview: 'classify me', occurred_at: NOW,
    });

    await classifier.runClassifierJob();
    let classRows = await db.select().from(schema.pulseClassifications).where(eq(schema.pulseClassifications.cowork_message_id, 'cm-1'));
    expect(classRows[0].classifier_attempts).toBe(1);
    expect(classRows[0].classifier_status).toBe('failed');

    // Second run hits the SAME row again — proves the ON CONFLICT DO UPDATE
    // path (classifier_attempts = classifier_attempts + 1), not a fresh insert.
    await classifier.runClassifierJob();
    classRows = await db.select().from(schema.pulseClassifications).where(eq(schema.pulseClassifications.cowork_message_id, 'cm-1'));
    expect(classRows[0].classifier_attempts).toBe(2);
    expect(classRows[0].classifier_status).toBe('failed');

    // ── (3) aggregator: pulse_metrics rolling + upserted-weekly row ─────────
    await db.insert(schema.coworkMessages).values({
      id: 'cm-2', session_id: 'sess-3', user_id: 'user-1', message_type: 'cowork_user_message',
      role: 'user', content_preview: 'do the thing', occurred_at: NOW - 100,
    });
    await db.insert(schema.pulseClassifications).values({
      cowork_message_id: 'cm-2', user_id: 'user-1', tier: 3, task_type: 'general',
      classifier_confidence: 0.9, classifier_model: 'test-model',
      classifier_status: 'classified', classified_at: NOW - 100,
    });

    await aggregator.runHourlyAggregation();
    await aggregator.runHourlyAggregation(); // second run: rolling inserts again, weekly upserts

    const rollingRows = await db.select().from(schema.pulseMetrics).where(
      eq(schema.pulseMetrics.scope_type, 'user'),
    );
    const rolling = rollingRows.filter((r: { granularity: string }) => r.granularity === 'rolling');
    const weekly = rollingRows.filter((r: { granularity: string }) => r.granularity === 'week');
    // The Postgres migration's unique index is FULL, so two runs that land
    // on the exact same period_start (as here, back-to-back within the same
    // wall-clock second) collide on the SAME index and the second is
    // deliberately onConflictDoNothing'd rather than thrown (see
    // writeMetric's rolling-branch comment) — so Postgres can legitimately
    // end up with only 1. What must hold is "at least one snapshot, never
    // zero, never a crash".
    expect(rolling.length).toBeGreaterThanOrEqual(1);
    expect(weekly.length).toBe(1); // two runs, same week -> one upserted weekly row
    expect(Number(weekly[0].tier_3_count)).toBe(1);
    expect(Number(rolling[0].tier_3_count)).toBe(1);

    // getCoworkCostUsd sums the same cowork_api_request rows seeded in (1) above.
    const costUsd = await aggregator.getCoworkCostUsd('user-1', NOW - 86400, NOW + 1);
    expect(costUsd).toBeCloseTo(0.52, 5);
  } finally {
    await cleanup();
  }
}

describe('Work Pulse aggregator + classifier + session-aggregator (postgres)', () => {
  it(
    'session token SUM/malformed-row tolerance, classifier ON CONFLICT increment, and aggregator pulse_metrics writes behave correctly on postgres',
    async () => {
      await runSpec();
    },
    180_000,
  );
});
