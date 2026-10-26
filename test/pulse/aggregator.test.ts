// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// lib/pulse/aggregator.ts (getTypedClient(), async Drizzle on
// Postgres). Real-DB harness (createTestDatabase() + seedUserSql()), same pattern
// as test/pulse/metrics.test.ts.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { TestSql } from '../helpers/sql';
import { createTestDatabase } from '../helpers/db';
import { seedUserSql } from '../helpers/seed';

let sql: TestSql;
let cleanup: () => Promise<void>;

let getCoworkCostUsd: typeof import('@/lib/pulse/aggregator').getCoworkCostUsd;
let getCoworkFrictionIndex: typeof import('@/lib/pulse/aggregator').getCoworkFrictionIndex;
let runHourlyAggregation: typeof import('@/lib/pulse/aggregator').runHourlyAggregation;
let runDailyAggregation: typeof import('@/lib/pulse/aggregator').runDailyAggregation;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const mod = await import('@/lib/pulse/aggregator');
  getCoworkCostUsd = mod.getCoworkCostUsd;
  getCoworkFrictionIndex = mod.getCoworkFrictionIndex;
  runHourlyAggregation = mod.runHourlyAggregation;
  runDailyAggregation = mod.runDailyAggregation;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`
    DELETE FROM pulse_metrics;
    DELETE FROM pulse_events;
    DELETE FROM pulse_classifications;
    DELETE FROM cowork_messages;
    DELETE FROM cowork_mcp_invocations;
    DELETE FROM cowork_skill_invocations;
    DELETE FROM pulse_user_prefs;
    DELETE FROM admin_users;
    DELETE FROM users;
  `);
});

let msgSeq = 0;
let classSeq = 0;
async function seedClassifiedEvent(userId: string, tier: number, occurredAt: number, taskType = 'general') {
  const msgId = `msg-${++msgSeq}`;
  await sql.run(`INSERT INTO cowork_messages
       (id, session_id, user_id, message_type, role, content_preview, occurred_at, ingested_at)
     VALUES (?, 'sess-1', ?, 'cowork_user_message', 'user', 'do the thing', ?, ?)`, [msgId, userId, occurredAt, occurredAt]);

  await sql.run(`INSERT INTO pulse_classifications
       (id, cowork_message_id, user_id, tier, task_type, classifier_confidence,
        classifier_model, classifier_status, classified_at)
     VALUES (?, ?, ?, ?, ?, 0.9, 'test-model', 'classified', ?)`, [++classSeq, msgId, userId, tier, taskType, occurredAt]);
}

describe('getCoworkCostUsd', () => {
  it('returns 0 when there are no cowork_api_request rows in the window', async () => {
    await seedUserSql(sql, 'user-1');
    expect(await getCoworkCostUsd('user-1', NOW - DAY, NOW)).toBe(0);
  });

  it('sums cost_usd for cowork_api_request rows within the window', async () => {
    await seedUserSql(sql, 'user-1');
    await sql.run(`
      INSERT INTO cowork_messages (id, session_id, user_id, message_type, occurred_at, cost_usd)
      VALUES ('m1', 's1', 'user-1', 'cowork_api_request', ?, 1.5)
    `, [NOW - 100]);
    await sql.run(`
      INSERT INTO cowork_messages (id, session_id, user_id, message_type, occurred_at, cost_usd)
      VALUES ('m2', 's1', 'user-1', 'cowork_api_request', ?, 2.25)
    `, [NOW - 50]);
    // Outside the window — must be excluded.
    await sql.run(`
      INSERT INTO cowork_messages (id, session_id, user_id, message_type, occurred_at, cost_usd)
      VALUES ('m3', 's1', 'user-1', 'cowork_api_request', ?, 100)
    `, [NOW - 10 * DAY]);

    const cost = await getCoworkCostUsd('user-1', NOW - DAY, NOW);
    expect(cost).toBeCloseTo(3.75, 5);
  });
});

describe('getCoworkFrictionIndex', () => {
  it('returns null when there is no tool_metadata activity in the window', async () => {
    await seedUserSql(sql, 'user-1');
    expect(await getCoworkFrictionIndex('user-1', NOW - DAY, NOW)).toBeNull();
  });

  it('computes failed/total ratio from tool_metadata rows', async () => {
    await seedUserSql(sql, 'user-1');
    for (let i = 0; i < 3; i++) {
      await sql.run(`
        INSERT INTO cowork_messages (id, session_id, user_id, message_type, occurred_at, tool_success)
        VALUES (?, 's1', 'user-1', 'cowork_tool_metadata', ?, 1)
      `, [`ok-${i}`, NOW - 10]);
    }
    await sql.run(`
      INSERT INTO cowork_messages (id, session_id, user_id, message_type, occurred_at, tool_success)
      VALUES ('fail-1', 's1', 'user-1', 'cowork_tool_metadata', ?, 0)
    `, [NOW - 10]);

    const fi = await getCoworkFrictionIndex('user-1', NOW - DAY, NOW);
    expect(fi).toBeCloseTo(0.25, 5);
  });
});

describe('runHourlyAggregation', () => {
  it('writes a rolling user-scope pulse_metrics row with correct tier counts', async () => {
    await seedUserSql(sql, 'user-1');
    await seedClassifiedEvent('user-1', 3, NOW - DAY);
    await seedClassifiedEvent('user-1', 1, NOW - DAY);

    await runHourlyAggregation();

    const row = (await sql.get(`SELECT * FROM pulse_metrics WHERE scope_type = 'user' AND scope_id = 'user-1' AND granularity = 'rolling'`)) as { tier_1_count: number; tier_3_count: number; event_count: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.tier_1_count).toBe(1);
    expect(row!.tier_3_count).toBe(1);
    expect(row!.event_count).toBe(2);
  });

  it('inserts a new rolling snapshot on every run (no upsert) but UPSERTs the weekly row', async () => {
    await seedUserSql(sql, 'user-1');
    await seedClassifiedEvent('user-1', 2, NOW - 100);

    await runHourlyAggregation();
    await runHourlyAggregation();

    const rollingRows = (await sql.all(`SELECT * FROM pulse_metrics WHERE scope_type = 'user' AND scope_id = 'user-1' AND granularity = 'rolling'`));
    // Two runs -> two independent rolling snapshots (never upserted).
    expect(rollingRows.length).toBe(2);

    const weekRows = (await sql.all(`SELECT * FROM pulse_metrics WHERE scope_type = 'user' AND scope_id = 'user-1' AND granularity = 'week'`)) as Array<{ tier_2_count: number }>;
    // Two runs at (roughly) the same period_start -> one upserted weekly row.
    expect(weekRows.length).toBe(1);
    expect(weekRows[0].tier_2_count).toBe(1);
  });

  it('writes per-team pulse_metrics rows for users sharing a team_id', async () => {
    await sql.run(`INSERT INTO users (id, email, team_id) VALUES ('u1', 'u1@test.local', 'team-a')`);
    await sql.run(`INSERT INTO users (id, email, team_id) VALUES ('u2', 'u2@test.local', 'team-a')`);
    await seedClassifiedEvent('u1', 3, NOW - 100);
    await seedClassifiedEvent('u2', 3, NOW - 100);

    await runHourlyAggregation();

    const teamRow = (await sql.get(`SELECT * FROM pulse_metrics WHERE scope_type = 'team' AND scope_id = 'team-a' AND granularity = 'rolling'`)) as { tier_3_count: number; event_count: number } | undefined;
    expect(teamRow).toBeDefined();
    expect(teamRow!.tier_3_count).toBe(2);
    expect(teamRow!.event_count).toBe(2);
  });

  it('writes per-department (function-scope) pulse_metrics rows via admin_users.linked_cowork_user_id', async () => {
    await seedUserSql(sql, 'user-1');
    await sql.run(`
      INSERT INTO admin_users (id, email, password_hash, department, linked_cowork_user_id)
      VALUES ('admin-1', 'admin1@test.local', 'x', 'Engineering', 'user-1')
    `);
    await seedClassifiedEvent('user-1', 2, NOW - 100);

    await runHourlyAggregation();

    const deptRow = (await sql.get(`SELECT * FROM pulse_metrics WHERE scope_type = 'function' AND scope_id = 'Engineering' AND granularity = 'rolling'`)) as { tier_2_count: number } | undefined;
    expect(deptRow).toBeDefined();
    expect(deptRow!.tier_2_count).toBe(1);
  });

  it('respects a per-user pulse_start_at floor on the rolling window', async () => {
    await seedUserSql(sql, 'user-1');
    const startAt = NOW - 3 * DAY;
    await sql.run(`INSERT INTO pulse_user_prefs (user_id, set_at, pulse_start_at) VALUES ('user-1', ?, ?)`, [NOW, startAt]);
    // Before pulse_start_at — must be excluded from the rolling window.
    await seedClassifiedEvent('user-1', 3, NOW - 6 * DAY);
    // After pulse_start_at — included.
    await seedClassifiedEvent('user-1', 1, NOW - 1 * DAY);

    await runHourlyAggregation();

    const row = (await sql.get(`SELECT * FROM pulse_metrics WHERE scope_type = 'user' AND scope_id = 'user-1' AND granularity = 'rolling'`)) as { tier_1_count: number; tier_3_count: number; period_start: number };
    expect(row.tier_1_count).toBe(1);
    expect(row.tier_3_count).toBe(0);
    expect(row.period_start).toBe(startAt);
  });
});

describe('runDailyAggregation', () => {
  it('writes function-scope pulse_metrics rows grouped by users.department', async () => {
    await sql.run(`INSERT INTO users (id, email, department) VALUES ('u1', 'u1@test.local', 'Legal')`);
    await sql.run(`INSERT INTO users (id, email, department) VALUES ('u2', 'u2@test.local', 'Legal')`);
    await seedClassifiedEvent('u1', 1, NOW - 100);
    await seedClassifiedEvent('u2', 2, NOW - 100);

    await runDailyAggregation();

    const row = (await sql.get(`SELECT * FROM pulse_metrics WHERE scope_type = 'function' AND scope_id = 'Legal'`)) as { tier_1_count: number; tier_2_count: number; event_count: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.tier_1_count).toBe(1);
    expect(row!.tier_2_count).toBe(1);
    expect(row!.event_count).toBe(2);
  });

  it('skips departments with no member users', async () => {
    await runDailyAggregation();
    const rows = (await sql.all(`SELECT * FROM pulse_metrics WHERE scope_type = 'function'`));
    expect(rows).toEqual([]);
  });
});
