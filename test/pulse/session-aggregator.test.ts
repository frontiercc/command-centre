// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// lib/pulse/cowork/session-aggregator.ts (getTypedClient(), async
// Drizzle on Postgres). Real-DB harness (createTestDatabase() + seedUserSql()),
// same pattern as test/pulse/metrics.test.ts / test/file-categories.test.ts.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { TestSql } from '../helpers/sql';
import { createTestDatabase } from '../helpers/db';
import { seedUserSql } from '../helpers/seed';

let sql: TestSql;
let cleanup: () => Promise<void>;

let aggregateCoworkSessionStats: typeof import('@/lib/pulse/cowork/session-aggregator').aggregateCoworkSessionStats;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  aggregateCoworkSessionStats = (await import('@/lib/pulse/cowork/session-aggregator')).aggregateCoworkSessionStats;

  await seedUserSql(sql, 'user-1');
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`
    DELETE FROM cowork_session_stats;
    DELETE FROM cowork_messages;
    DELETE FROM cowork_sessions;
  `);
});

const NOW = Math.floor(Date.now() / 1000);

async function insertSession(id: string, overrides: Partial<{
  conversation_id: string; user_id: string; files_uploaded: string | null; started_at: number;
}> = {}) {
  await sql.run(`INSERT INTO cowork_sessions (id, conversation_id, user_id, files_uploaded, started_at)
     VALUES (?, ?, ?, ?, ?)`, [id,
    overrides.conversation_id ?? `conv-${id}`,
    overrides.user_id ?? 'user-1',
    overrides.files_uploaded === undefined ? null : overrides.files_uploaded,
    overrides.started_at ?? NOW]);
}

let msgSeq = 0;
async function insertApiRequestMessage(sessionId: string, opts: {
  userId?: string; model?: string | null; costUsd?: number | null;
  tokens?: { inputTokens?: number | null; outputTokens?: number | null; cacheReadTokens?: number | null; cacheCreationTokens?: number | null };
  contentPreviewOverride?: string; occurredAt?: number; surface?: string | null;
} = {}) {
  const id = `msg-${++msgSeq}`;
  const model = opts.model === undefined ? 'claude-haiku-4-5' : opts.model;
  const tokenUsage = JSON.stringify({
    inputTokens: opts.tokens?.inputTokens ?? 100,
    outputTokens: opts.tokens?.outputTokens ?? 50,
    cacheReadTokens: opts.tokens?.cacheReadTokens ?? 10,
    cacheCreationTokens: opts.tokens?.cacheCreationTokens ?? 5,
  });
  const contentPreview = opts.contentPreviewOverride ?? `${model ?? 'unknown'} | ${tokenUsage}`;
  await sql.run(`
    INSERT INTO cowork_messages
      (id, session_id, user_id, message_type, surface, source, model, cost_usd, token_usage, content_preview, occurred_at)
    VALUES (?, ?, ?, 'cowork_api_request', ?, 'otel', ?, ?, ?, ?, ?)
  `, [id, sessionId, opts.userId ?? 'user-1', opts.surface === undefined ? 'cowork' : opts.surface, model,
    opts.costUsd === undefined ? 0.01 : opts.costUsd,
    tokenUsage, contentPreview, opts.occurredAt ?? NOW]);
  return id;
}

async function insertToolMetadataMessage(sessionId: string, toolName: string, opts: { userId?: string; occurredAt?: number; surface?: string | null } = {}) {
  const id = `msg-${++msgSeq}`;
  await sql.run(`
    INSERT INTO cowork_messages
      (id, session_id, user_id, message_type, surface, source, content_preview, occurred_at)
    VALUES (?, ?, ?, 'cowork_tool_metadata', ?, 'otel', ?, ?)
  `, [id, sessionId, opts.userId ?? 'user-1', opts.surface === undefined ? 'cowork' : opts.surface, toolName, opts.occurredAt ?? NOW]);
  return id;
}

describe('aggregateCoworkSessionStats', () => {
  it('returns zero counts when there are no OTel sessions', async () => {
    const result = await aggregateCoworkSessionStats();
    expect(result).toEqual({ sessionsProcessed: 0, sessionsUpserted: 0, errors: [], remaining: 0 });
  });

  it('sums tokens + cost across api_request rows and writes cowork_session_stats', async () => {
    await insertSession('s1');
    await insertApiRequestMessage('s1', { tokens: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 5 }, costUsd: 0.02 });
    await insertApiRequestMessage('s1', { tokens: { inputTokens: 200, outputTokens: 75, cacheReadTokens: 20, cacheCreationTokens: 0 }, costUsd: 0.03 });

    const result = await aggregateCoworkSessionStats('s1');
    expect(result.sessionsProcessed).toBe(1);
    expect(result.sessionsUpserted).toBe(1);
    expect(result.errors).toEqual([]);

    const row = (await sql.get('SELECT * FROM cowork_session_stats WHERE session_id = ?', ['s1'])) as {
      total_input_tokens: number; total_output_tokens: number; total_cache_read_tokens: number;
      total_cache_creation_tokens: number; total_cost_usd: number; tool_call_count: number;
    };
    expect(row.total_input_tokens).toBe(300);
    expect(row.total_output_tokens).toBe(125);
    expect(row.total_cache_read_tokens).toBe(30);
    expect(row.total_cache_creation_tokens).toBe(5);
    expect(row.total_cost_usd).toBeCloseTo(0.05, 5);
    expect(row.tool_call_count).toBe(0);
  });

  it('tolerates a malformed content_preview row (no separator) without aborting the session sum', async () => {
    await insertSession('s1');
    await insertApiRequestMessage('s1', { tokens: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 }, costUsd: 0.01 });
    // Malformed: no " | " separator at all.
    await insertApiRequestMessage('s1', { contentPreviewOverride: 'not-a-valid-preview', costUsd: 0.5 });

    const result = await aggregateCoworkSessionStats('s1');
    expect(result.errors).toEqual([]);
    expect(result.sessionsUpserted).toBe(1);

    const row = (await sql.get('SELECT * FROM cowork_session_stats WHERE session_id = ?', ['s1'])) as {
      total_input_tokens: number; total_cost_usd: number;
    };
    // The malformed row's tokens are excluded (NULL-tolerant), but its
    // cost_usd is still summed — cost comes from the real column, not from
    // parsing content_preview.
    expect(row.total_input_tokens).toBe(100);
    expect(row.total_cost_usd).toBeCloseTo(0.51, 5);
  });

  it('tolerates a malformed JSON tail (invalid JSON after the separator) without throwing', async () => {
    await insertSession('s1');
    await insertApiRequestMessage('s1', { contentPreviewOverride: 'claude-haiku | {not valid json', costUsd: 0.1 });
    await insertApiRequestMessage('s1', { tokens: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 }, costUsd: 0.01 });

    const result = await aggregateCoworkSessionStats('s1');
    expect(result.errors).toEqual([]);

    const row = (await sql.get('SELECT * FROM cowork_session_stats WHERE session_id = ?', ['s1'])) as {
      total_input_tokens: number; total_cost_usd: number;
    };
    expect(row.total_input_tokens).toBe(10);
    expect(row.total_cost_usd).toBeCloseTo(0.11, 5);
  });

  it('counts tool_metadata rows and collects unique tool names', async () => {
    await insertSession('s1');
    await insertToolMetadataMessage('s1', 'read_file');
    await insertToolMetadataMessage('s1', 'read_file');
    await insertToolMetadataMessage('s1', 'write_file');

    const result = await aggregateCoworkSessionStats('s1');
    expect(result.sessionsUpserted).toBe(1);

    const row = (await sql.get('SELECT * FROM cowork_session_stats WHERE session_id = ?', ['s1'])) as {
      tool_call_count: number; unique_tools: string;
    };
    expect(row.tool_call_count).toBe(3);
    expect(JSON.parse(row.unique_tools).sort()).toEqual(['read_file', 'write_file']);
  });

  it('computes duration from first/last occurred_at across all OTel rows', async () => {
    await insertSession('s1');
    await insertApiRequestMessage('s1', { occurredAt: NOW - 100 });
    await insertToolMetadataMessage('s1', 'read_file', { occurredAt: NOW });

    await aggregateCoworkSessionStats('s1');
    const row = (await sql.get('SELECT * FROM cowork_session_stats WHERE session_id = ?', ['s1'])) as {
      first_event_at: number; last_event_at: number; duration_secs: number;
    };
    expect(row.first_event_at).toBe(NOW - 100);
    expect(row.last_event_at).toBe(NOW);
    expect(row.duration_secs).toBe(100);
  });

  it('active_secs is gap-based, not wall time — a >30min gap is excluded from the sum', async () => {
    await insertSession('s1');
    const t0 = NOW - 4500;
    // 10-minute gap (active), then a 1-hour idle gap (excluded), then a
    // 5-minute gap (active). Wall time = 600 + 3600 + 300 = 4500s (75 min);
    // active time = only the two small gaps = 900s.
    await insertApiRequestMessage('s1', { occurredAt: t0 });
    await insertToolMetadataMessage('s1', 'read_file', { occurredAt: t0 + 600 });
    await insertToolMetadataMessage('s1', 'write_file', { occurredAt: t0 + 600 + 3600 });
    await insertApiRequestMessage('s1', { occurredAt: t0 + 600 + 3600 + 300 });

    await aggregateCoworkSessionStats('s1');
    const row = (await sql.get('SELECT * FROM cowork_session_stats WHERE session_id = ?', ['s1'])) as {
      duration_secs: number; active_secs: number;
    };
    expect(row.duration_secs).toBe(4500);
    expect(row.active_secs).toBe(900);
  });

  it('active_secs is 0 for a single-event session', async () => {
    await insertSession('s1');
    await insertApiRequestMessage('s1', { occurredAt: NOW });

    await aggregateCoworkSessionStats('s1');
    const row = (await sql.get('SELECT * FROM cowork_session_stats WHERE session_id = ?', ['s1'])) as {
      duration_secs: number; active_secs: number;
    };
    expect(row.duration_secs).toBe(0);
    expect(row.active_secs).toBe(0);
  });

  it('derives upload_count from cowork_sessions.files_uploaded JSON', async () => {
    await insertSession('s1', { files_uploaded: JSON.stringify(['a.pdf', 'b.pdf']) });
    await insertApiRequestMessage('s1');

    await aggregateCoworkSessionStats('s1');
    const row = (await sql.get('SELECT * FROM cowork_session_stats WHERE session_id = ?', ['s1'])) as { upload_count: number };
    expect(row.upload_count).toBe(2);
  });

  it('tolerates malformed files_uploaded JSON (upload_count stays 0)', async () => {
    await insertSession('s1', { files_uploaded: 'not json{{' });
    await insertApiRequestMessage('s1');

    const result = await aggregateCoworkSessionStats('s1');
    expect(result.errors).toEqual([]);
    const row = (await sql.get('SELECT * FROM cowork_session_stats WHERE session_id = ?', ['s1'])) as { upload_count: number };
    expect(row.upload_count).toBe(0);
  });

  it('is safe to run twice — UPSERTs the same session_id rather than duplicating', async () => {
    await insertSession('s1');
    await insertApiRequestMessage('s1', { tokens: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } });

    await aggregateCoworkSessionStats('s1');
    await aggregateCoworkSessionStats('s1');

    const rows = (await sql.all('SELECT * FROM cowork_session_stats WHERE session_id = ?', ['s1']));
    expect(rows).toHaveLength(1);
  });

  it('only processes sessions with source=otel messages', async () => {
    await insertSession('s1');
    await sql.run(`
      INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, content_preview, occurred_at)
      VALUES ('agent-msg', 's1', 'user-1', 'cowork_user_message', 'cowork', 'agent', 'hello', ?)
    `, [NOW]);

    const result = await aggregateCoworkSessionStats();
    expect(result.sessionsProcessed).toBe(0);
  });

  it('processes all pending sessions when no sessionId is passed', async () => {
    await insertSession('s1');
    await insertSession('s2');
    await insertApiRequestMessage('s1');
    await insertApiRequestMessage('s2');

    const result = await aggregateCoworkSessionStats();
    expect(result.sessionsProcessed).toBe(2);
    expect(result.sessionsUpserted).toBe(2);
  });

  it('skips re-aggregating a session whose stats are already up to date', async () => {
    await insertSession('s1');
    await insertApiRequestMessage('s1');
    await aggregateCoworkSessionStats('s1');

    // No new messages since — a second full run (no sessionId filter) should
    // find nothing pending for s1.
    const result = await aggregateCoworkSessionStats();
    expect(result.sessionsProcessed).toBe(0);
  });

  // Root-cause coverage: rawSessionsNeedingAggregation used to INNER JOIN
  // cowork_sessions, so any cowork session whose cowork_sessions row is
  // missing (ETL'd/seeded history, or any client that never wrote one) could
  // NEVER be aggregated. No insertSession() call in this test — deliberately.
  it('aggregates a cowork-surface otel session with NO cowork_sessions row', async () => {
    await insertApiRequestMessage('s1', {
      tokens: { inputTokens: 40, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
      costUsd: 0.02,
      occurredAt: NOW - 60,
    });
    await insertToolMetadataMessage('s1', 'read_file', { occurredAt: NOW });

    const result = await aggregateCoworkSessionStats('s1');
    expect(result.errors).toEqual([]);
    expect(result.sessionsProcessed).toBe(1);
    expect(result.sessionsUpserted).toBe(1);

    const row = (await sql.get('SELECT * FROM cowork_session_stats WHERE session_id = ?', ['s1'])) as {
      total_input_tokens: number; duration_secs: number; upload_count: number;
    };
    expect(row.total_input_tokens).toBe(40);
    expect(row.duration_secs).toBe(60);
    // No cowork_sessions row to read files_uploaded from — upload_count falls
    // back to 0 rather than crashing the aggregation.
    expect(row.upload_count).toBe(0);
  });

  it('does NOT treat a surface=code otel session as a candidate (no cowork_sessions row either)', async () => {
    await insertApiRequestMessage('code-s1', { surface: 'code' });

    const result = await aggregateCoworkSessionStats();
    expect(result.sessionsProcessed).toBe(0);

    const row = (await sql.get('SELECT * FROM cowork_session_stats WHERE session_id = ?', ['code-s1']));
    expect(row).toBeUndefined();
  });

  it('folds a NULL-surface otel session into cowork (same convention as the retention engine)', async () => {
    await insertApiRequestMessage('null-surf-s1', { surface: null });

    const result = await aggregateCoworkSessionStats('null-surf-s1');
    expect(result.sessionsProcessed).toBe(1);
    expect(result.sessionsUpserted).toBe(1);
  });

  it('honours a per-run limit and reports how many candidates remain', async () => {
    for (let i = 0; i < 3; i++) {
      await insertApiRequestMessage(`cap-s${i}`);
    }

    const result = await aggregateCoworkSessionStats(undefined, 2);
    expect(result.sessionsProcessed).toBe(2);
    expect(result.sessionsUpserted).toBe(2);
    expect(result.remaining).toBe(1);
  });

  it('reports remaining=0 when every candidate fits under the cap', async () => {
    await insertApiRequestMessage('s1');
    await insertApiRequestMessage('s2');

    const result = await aggregateCoworkSessionStats(undefined, 500);
    expect(result.sessionsProcessed).toBe(2);
    expect(result.remaining).toBe(0);
  });

  // Defence-in-depth: a hypothetical session id shared across surfaces (the
  // discovery query only requires ONE cowork-surface row to become a
  // candidate) must never let a surface='code' row's tokens/duration/tool
  // calls bleed into cowork stats — that would double-count downstream in
  // lib/usecases/impact-rollup.ts, which sums cowork + code duration per
  // matched session.
  it('aggregates only the cowork-surface rows of a mixed-surface session id', async () => {
    await insertApiRequestMessage('mixed-s1', {
      surface: 'cowork',
      tokens: { inputTokens: 40, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
      costUsd: 0.02,
      occurredAt: NOW - 60,
    });
    await insertApiRequestMessage('mixed-s1', {
      surface: 'code',
      tokens: { inputTokens: 9000, outputTokens: 9000, cacheReadTokens: 9000, cacheCreationTokens: 9000 },
      costUsd: 99,
      occurredAt: NOW - 500,
    });
    await insertToolMetadataMessage('mixed-s1', 'read_file', { surface: 'code', occurredAt: NOW - 400 });

    const result = await aggregateCoworkSessionStats('mixed-s1');
    expect(result.errors).toEqual([]);
    expect(result.sessionsUpserted).toBe(1);

    const row = (await sql.get('SELECT * FROM cowork_session_stats WHERE session_id = ?', ['mixed-s1'])) as {
      total_input_tokens: number; total_cost_usd: number; duration_secs: number;
      first_event_at: number; last_event_at: number; tool_call_count: number;
    };
    // Only the cowork-surface api_request row's figures — the surface='code'
    // rows (tokens, cost, tool call, and their earlier occurred_at) must be
    // entirely excluded.
    expect(row.total_input_tokens).toBe(40);
    expect(row.total_cost_usd).toBeCloseTo(0.02, 5);
    expect(row.tool_call_count).toBe(0);
    expect(row.first_event_at).toBe(NOW - 60);
    expect(row.last_event_at).toBe(NOW - 60);
    expect(row.duration_secs).toBe(0);
  });
});
