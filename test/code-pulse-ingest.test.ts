// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import { seedUserSql } from './helpers/seed';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;

const NOW = Math.floor(Date.now() / 1000);

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  await seedUserSql(sql, 'user-1');
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec('DELETE FROM code_assistant_meta');
});

// Mirrors the code_assistant_meta insert in lib/otel/code-receiver.ts
// (insert ... on conflict do nothing). Returns the number of rows written.
async function insertMeta(row: {
  id: string; userId?: string; sessionId?: string; model?: string;
  inputTokens?: number; outputTokens?: number; cacheCreation?: number;
  cacheRead?: number; stopReason?: string; toolUseCount?: number; occurredAt?: number;
}): Promise<number> {
  const written = await sql.all(
    `INSERT INTO code_assistant_meta
       (id, user_id, session_id, model, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens, stop_reason, tool_use_count, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      row.id, row.userId ?? 'user-1', row.sessionId ?? 'sess-1', row.model ?? 'claude-fable-5',
      row.inputTokens ?? 0, row.outputTokens ?? 0, row.cacheCreation ?? 0,
      row.cacheRead ?? 0, row.stopReason ?? 'end_turn', row.toolUseCount ?? 0,
      row.occurredAt ?? NOW,
    ],
  );
  return written.length;
}

describe('code_assistant_meta schema (migration 027)', () => {
  it('creates the table with expected columns', async () => {
    const cols = await sql.all<{ name: string }>(
      `SELECT column_name AS name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'code_assistant_meta'`,
    );
    const names = cols.map(c => c.name);
    for (const expected of [
      'id', 'user_id', 'session_id', 'model', 'input_tokens', 'output_tokens',
      'cache_creation_tokens', 'cache_read_tokens', 'stop_reason',
      'tool_use_count', 'error_count', 'occurred_at', 'ingested_at',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('creates code_session_stats and code_metrics tables', async () => {
    const tables = await sql.all<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('code_session_stats','code_metrics')`,
    );
    expect(tables).toHaveLength(2);
  });

  it('seeds the code_pulse_enabled config key', async () => {
    const enabled = await sql.get<{ value: string }>(`SELECT value FROM config WHERE key='code_pulse_enabled'`);
    expect(enabled?.value).toBe('true');
  });
});

describe('code_assistant_meta ingest semantics', () => {
  it('inserts a row with token fields and defaults error_count to 0', async () => {
    const changes = await insertMeta({ id: 'uuid-1', inputTokens: 5244, outputTokens: 257, cacheCreation: 9523, cacheRead: 25145, toolUseCount: 2, stopReason: 'tool_use' });
    expect(changes).toBe(1);
    const row = (await sql.get<Record<string, unknown>>(`SELECT * FROM code_assistant_meta WHERE id='uuid-1'`))!;
    expect(row.input_tokens).toBe(5244);
    expect(row.cache_read_tokens).toBe(25145);
    expect(row.tool_use_count).toBe(2);
    expect(row.error_count).toBe(0);
    expect(row.ingested_at).toBeGreaterThan(0);
  });

  it('is idempotent — duplicate uuid is ignored, first write wins', async () => {
    await insertMeta({ id: 'uuid-dup', inputTokens: 100 });
    const second = await insertMeta({ id: 'uuid-dup', inputTokens: 999 });
    expect(second).toBe(0);
    const row = (await sql.get<{ input_tokens: number }>(`SELECT input_tokens FROM code_assistant_meta WHERE id='uuid-dup'`))!;
    expect(row.input_tokens).toBe(100);
    expect(await sql.get(`SELECT COUNT(*) AS c FROM code_assistant_meta`)).toEqual({ c: 1 });
  });
});
