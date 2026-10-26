// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import { seedUserSql } from './helpers/seed';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
let runCodeHourlyAggregation: typeof import('@/lib/pulse/code/aggregator').runCodeHourlyAggregation;

const NOW = Math.floor(Date.now() / 1000);

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const agg = await import('@/lib/pulse/code/aggregator');
  runCodeHourlyAggregation = agg.runCodeHourlyAggregation;

  await seedUserSql(sql, 'user-1');
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`DELETE FROM code_assistant_meta;
           DELETE FROM code_session_stats;
           DELETE FROM code_metrics;
           DELETE FROM cowork_messages;
           DELETE FROM cowork_skill_invocations;
           DELETE FROM config WHERE key = 'code_aggregator_last_run';`);
});

async function seedMeta(opts: { id: string; sessionId: string; input?: number; tools?: number; ingestedAt?: number }) {
  await sql.run(
    `INSERT INTO code_assistant_meta
       (id, user_id, session_id, model, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens, stop_reason, tool_use_count,
        commit_count, cwd, git_branch, occurred_at, ingested_at)
     VALUES (?, 'user-1', ?, 'claude-haiku-4-5', ?, 0, 0, 0, 'end_turn', ?, 0, 'C:\\code\\my-app', 'main', ?, ?)`,
    [opts.id, opts.sessionId, opts.input ?? 1000, opts.tools ?? 1, NOW, opts.ingestedAt ?? NOW],
  );
}

async function seedUserMsg(id: string, sessionId: string) {
  await sql.run(
    `INSERT INTO cowork_messages
       (id, session_id, user_id, message_type, role, content_preview, surface, occurred_at, ingested_at)
     VALUES (?, ?, 'user-1', 'code_user_message', 'user', 'do the thing', 'code', ?, ?)`,
    [id, sessionId, NOW, NOW],
  );
}

describe('runCodeHourlyAggregation — weekly rows', () => {
  it('upserts exactly one weekly org row across two runs, alongside two rolling rows', async () => {
    await seedMeta({ id: 'm1', sessionId: 's1', input: 1000, tools: 2 });
    await seedUserMsg('u1', 's1');

    await runCodeHourlyAggregation();
    await runCodeHourlyAggregation();

    const weekly = (await sql.all(
      `SELECT * FROM code_metrics WHERE scope_type = 'organisation' AND granularity = 'week'`
    )) as Array<Record<string, unknown>>;
    expect(weekly).toHaveLength(1);

    const rolling = (await sql.all(
      `SELECT * FROM code_metrics WHERE scope_type = 'organisation' AND granularity = 'rolling'`
    )) as Array<Record<string, unknown>>;
    expect(rolling).toHaveLength(2);
  });

  it('the weekly row reflects the latest data after the second run', async () => {
    await seedMeta({ id: 'm1', sessionId: 's1', input: 1000, tools: 1 });
    await seedUserMsg('u1', 's1');
    await runCodeHourlyAggregation();

    // ingested_at must clear the high-water mark the first run just set
    await seedMeta({ id: 'm2', sessionId: 's1', input: 1000, tools: 1, ingestedAt: Math.floor(Date.now() / 1000) + 5 });
    await runCodeHourlyAggregation();

    const weekly = (await sql.get(
      `SELECT input_tokens FROM code_metrics WHERE scope_type = 'organisation' AND granularity = 'week'`
    )) as { input_tokens: number };
    expect(weekly.input_tokens).toBe(2000);
  });
});
