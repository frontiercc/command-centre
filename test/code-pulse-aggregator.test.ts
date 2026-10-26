// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import { seedUserSql } from './helpers/seed';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
let rollupCodeSessionStats: typeof import('@/lib/pulse/code/aggregator').rollupCodeSessionStats;
let runCodeHourlyAggregation: typeof import('@/lib/pulse/code/aggregator').runCodeHourlyAggregation;
let deriveRepo: typeof import('@/lib/pulse/code/aggregator').deriveRepo;

const NOW = Math.floor(Date.now() / 1000);

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const agg = await import('@/lib/pulse/code/aggregator');
  rollupCodeSessionStats = agg.rollupCodeSessionStats;
  runCodeHourlyAggregation = agg.runCodeHourlyAggregation;
  deriveRepo = agg.deriveRepo;

  await seedUserSql(sql, 'user-1');
  await seedUserSql(sql, 'user-2');
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

async function seedMeta(opts: {
  id: string; sessionId: string; userId?: string; model?: string;
  input?: number; output?: number; cacheCreate?: number; cacheRead?: number;
  tools?: number; commits?: number; cwd?: string; occurredAt?: number;
}) {
  await sql.run(
    `INSERT INTO code_assistant_meta
       (id, user_id, session_id, model, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens, stop_reason, tool_use_count,
        commit_count, cwd, git_branch, occurred_at, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'end_turn', ?, ?, ?, 'main', ?, ?)`,
    [
    opts.id, opts.userId ?? 'user-1', opts.sessionId, opts.model ?? 'claude-haiku-4-5',
    opts.input ?? 0, opts.output ?? 0, opts.cacheCreate ?? 0, opts.cacheRead ?? 0,
    opts.tools ?? 0, opts.commits ?? 0, opts.cwd ?? 'C:\\code\\my-app', opts.occurredAt ?? NOW, NOW,
    ],
  );
}

async function seedUserMsg(id: string, sessionId: string, userId = 'user-1', occurredAt = NOW) {
  await sql.run(
    `INSERT INTO cowork_messages
       (id, session_id, user_id, message_type, role, content_preview, surface, occurred_at, ingested_at)
     VALUES (?, ?, ?, 'code_user_message', 'user', 'do the thing', 'code', ?, ?)`,
    [id, sessionId, userId, occurredAt, NOW],
  );
}

describe('deriveRepo', () => {
  it('takes the last path segment, Windows or POSIX', () => {
    expect(deriveRepo('C:\\Users\\alex\\code\\my-app')).toBe('my-app');
    expect(deriveRepo('/home/alex/work/api/')).toBe('api');
    expect(deriveRepo('/sessions/cosy-otter')).toBe('cosy-otter');
  });

  it('returns null for empty input', () => {
    expect(deriveRepo('')).toBeNull();
    expect(deriveRepo(null)).toBeNull();
    expect(deriveRepo(undefined)).toBeNull();
  });
});

describe('rollupCodeSessionStats', () => {
  it('rolls a session up from meta + user messages', async () => {
    await seedMeta({ id: 'm1', sessionId: 's1', input: 1000, output: 200, cacheRead: 5000, tools: 3 });
    await seedMeta({ id: 'm2', sessionId: 's1', input: 500, output: 100, tools: 1 });
    await seedUserMsg('u1', 's1');
    await seedUserMsg('u2', 's1');

    expect(await rollupCodeSessionStats()).toBe(1);

    const row = (await sql.get(`SELECT * FROM code_session_stats WHERE session_id = 's1'`)) as Record<string, unknown>;
    expect(row.user_id).toBe('user-1');
    expect(row.repo).toBe('my-app');
    expect(row.user_msg_count).toBe(2);
    expect(row.assistant_turns).toBe(2);
    expect(row.tool_use_count).toBe(4);
    expect(row.input_tokens).toBe(1500);
    expect(row.output_tokens).toBe(300);
    expect(row.cache_read_tokens).toBe(5000);
    const models = JSON.parse(row.models_json as string);
    expect(models['claude-haiku-4-5'].input).toBe(1500);
  });

  it('is idempotent — re-running with no new data leaves one row', async () => {
    await seedMeta({ id: 'm1', sessionId: 's1', input: 100 });
    await rollupCodeSessionStats();
    await rollupCodeSessionStats();
    expect(await sql.get(`SELECT COUNT(*) c FROM code_session_stats`)).toEqual({ c: 1 });
  });

  it('skips sessions ingested before the high-water mark', async () => {
    await seedMeta({ id: 'm-old', sessionId: 's-old', input: 100 });
    // Mark the last run as the future — nothing should qualify
    await sql.run(`INSERT INTO config (key, value) VALUES ('code_aggregator_last_run', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [new Date(Date.now() + 60_000).toISOString()]);
    expect(await rollupCodeSessionStats()).toBe(0);
  });

  it('active_secs is gap-based, not wall time — a >30min gap is excluded from the sum', async () => {
    const t0 = NOW - 4500;
    // Assistant + user events interleaved: 10-minute gap (active), then a
    // 1-hour idle gap (excluded), then a 5-minute gap (active). Wall time
    // (last_at - first_at) = 600 + 3600 + 300 = 4500s; active time = 900s.
    await seedMeta({ id: 'm1', sessionId: 's1', input: 100, occurredAt: t0 });
    await seedUserMsg('u1', 's1', 'user-1', t0 + 600);
    await seedMeta({ id: 'm2', sessionId: 's1', input: 100, occurredAt: t0 + 600 + 3600 });
    await seedUserMsg('u2', 's1', 'user-1', t0 + 600 + 3600 + 300);

    await rollupCodeSessionStats();
    const row = (await sql.get(`SELECT * FROM code_session_stats WHERE session_id = 's1'`)) as {
      first_at: number; last_at: number; active_secs: number;
    };
    expect(row.last_at - row.first_at).toBe(4500);
    expect(row.active_secs).toBe(900);
  });

  it('active_secs is 0 for a single-event session', async () => {
    await seedMeta({ id: 'm1', sessionId: 's1', input: 100, occurredAt: NOW });

    await rollupCodeSessionStats();
    const row = (await sql.get(`SELECT * FROM code_session_stats WHERE session_id = 's1'`)) as {
      first_at: number; last_at: number; active_secs: number;
    };
    expect(row.first_at).toBe(row.last_at);
    expect(row.active_secs).toBe(0);
  });
});

describe('runCodeHourlyAggregation', () => {
  it('writes organisation and user scope metrics with correct maths', async () => {
    // haiku rates: $1 in / $5 out / $1.25 cacheWrite / $0.1 cacheRead per MTok
    await seedMeta({ id: 'm1', sessionId: 's1', input: 1_000_000, output: 200_000, cacheRead: 4_000_000, tools: 6 });
    await seedUserMsg('u1', 's1');
    await seedUserMsg('u2', 's1');
    await seedUserMsg('u3', 's1');
    await sql.run(
      `INSERT INTO cowork_skill_invocations (id, user_id, session_id, skill_name, invocation_type, occurred_at)
       VALUES ('sk1', 'user-1', 's1', 'review', 'agent_chained', ?), ('sk2', 'user-1', 's1', 'verify', 'user_typed', ?)`,
      [NOW, NOW],
    );

    await runCodeHourlyAggregation();

    const org = (await sql.get(
      `SELECT * FROM code_metrics WHERE scope_type = 'organisation' ORDER BY id DESC LIMIT 1`
    )) as Record<string, number>;
    // spend: 1M×$1 + 0.2M×$5 + 4M×$0.1 = 1 + 1 + 0.4 = 2.4
    expect(org.spend_usd).toBeCloseTo(2.4, 6);
    expect(org.autonomy_ratio).toBeCloseTo(2, 6);           // 6 tools / 3 msgs
    expect(org.cache_hit_ratio).toBeCloseTo(0.8, 6);        // 4M / (4M + 1M)
    expect(org.session_count).toBe(1);
    expect(org.repo_count).toBe(1);
    expect(org.skill_leverage).toBeCloseTo(0.5, 6);         // 1 chained / 2 total

    const user = (await sql.get(
      `SELECT * FROM code_metrics WHERE scope_type = 'user' AND scope_id = 'user-1' ORDER BY id DESC LIMIT 1`
    )) as Record<string, number>;
    expect(user.spend_usd).toBeCloseTo(2.4, 6);
  });

  it('reports null spend (not zero) when only unpriced models have tokens', async () => {
    await seedMeta({ id: 'm1', sessionId: 's2', userId: 'user-2', model: 'mystery-model', input: 100_000 });
    await seedUserMsg('u1', 's2', 'user-2');

    await runCodeHourlyAggregation();

    const user = (await sql.get(
      `SELECT spend_usd, input_tokens FROM code_metrics WHERE scope_type = 'user' AND scope_id = 'user-2' ORDER BY id DESC LIMIT 1`
    )) as { spend_usd: number | null; input_tokens: number };
    expect(user.spend_usd).toBeNull();
    expect(user.input_tokens).toBe(100_000); // tokens still reported
  });

  it('rolls commit counts through session stats into scope metrics', async () => {
    await seedMeta({ id: 'm1', sessionId: 's1', input: 1000, commits: 2, tools: 4 });
    await seedMeta({ id: 'm2', sessionId: 's1', input: 500, commits: 1, tools: 2 });
    await seedUserMsg('u1', 's1');

    await runCodeHourlyAggregation();

    const stats = (await sql.get(`SELECT commit_count FROM code_session_stats WHERE session_id = 's1'`)) as { commit_count: number };
    expect(stats.commit_count).toBe(3);
    const org = (await sql.get(
      `SELECT commit_count FROM code_metrics WHERE scope_type = 'organisation' ORDER BY id DESC LIMIT 1`
    )) as { commit_count: number };
    expect(org.commit_count).toBe(3);
  });

  it('writes function-scope metrics grouped by users.department', async () => {
    await sql.run(`UPDATE users SET department = 'Engineering' WHERE id = 'user-1'`);
    await seedMeta({ id: 'm1', sessionId: 's1', input: 50_000, output: 10_000, tools: 2 });
    await seedUserMsg('u1', 's1');

    await runCodeHourlyAggregation();

    const dept = (await sql.get(
      `SELECT spend_usd, session_count FROM code_metrics
       WHERE scope_type = 'function' AND scope_id = 'Engineering' ORDER BY id DESC LIMIT 1`
    )) as { spend_usd: number; session_count: number } | undefined;
    expect(dept).toBeDefined();
    expect(dept!.session_count).toBe(1);
    // haiku: 50K×$1/M + 10K×$5/M = 0.05 + 0.05 = 0.1
    expect(dept!.spend_usd).toBeCloseTo(0.1, 6);
    await sql.run(`UPDATE users SET department = NULL WHERE id = 'user-1'`);
  });

  it('advances the high-water mark after a run', async () => {
    await seedMeta({ id: 'm1', sessionId: 's1', input: 10 });
    await runCodeHourlyAggregation();
    const mark = (await sql.get(`SELECT value FROM config WHERE key = 'code_aggregator_last_run'`)) as { value: string };
    expect(new Date(mark.value).getTime()).toBeGreaterThan(0);
  });
});
