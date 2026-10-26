// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
let otelMetricsForUsers: (userIds: string[], windowStart: number) => Promise<{
  activeTimeUserS: number; activeTimeCliS: number; linesAdded: number;
  linesRemoved: number; prCount: number; editAccept: number; editReject: number;
}>;
let runCodeHourlyAggregation: () => Promise<void>;

const USER = 'usr_agg01';
const now = Math.floor(Date.now() / 1000);
const recent = now - 3600;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  const mod = await import('@/lib/pulse/code/aggregator');
  otelMetricsForUsers = mod.otelMetricsForUsers;
  runCodeHourlyAggregation = mod.runCodeHourlyAggregation;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`DELETE FROM code_otel_metrics`);
  await sql.exec(`DELETE FROM code_metrics`);
  await sql.exec(`DELETE FROM code_session_stats`);
  await sql.run(`DELETE FROM users WHERE id = ?`, [USER]);
});

async function seedMetric(metric: string, value: number, type: string | null) {
  await sql.run(
    `INSERT INTO code_otel_metrics (id, user_id, session_id, metric_name, value, type, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [`${metric}|${type}|${value}`, USER, 'sess_agg', metric, value, type, recent],
  );
}

describe('otelMetricsForUsers', () => {
  it('sums the Phase 1 metrics by type', async () => {
    await seedMetric('claude_code.active_time.total', 600, 'user');
    await seedMetric('claude_code.active_time.total', 1800, 'cli');
    await seedMetric('claude_code.lines_of_code.count', 120, 'added');
    await seedMetric('claude_code.lines_of_code.count', 40, 'removed');
    await seedMetric('claude_code.pull_request.count', 2, null);
    await seedMetric('claude_code.code_edit_tool.decision', 9, 'accept');
    await seedMetric('claude_code.code_edit_tool.decision', 1, 'reject');

    const agg = await otelMetricsForUsers([USER], now - 7 * 24 * 3600);
    expect(agg).toEqual({
      activeTimeUserS: 600, activeTimeCliS: 1800,
      linesAdded: 120, linesRemoved: 40,
      prCount: 2, editAccept: 9, editReject: 1,
    });
  });

  it('returns zeros for an unknown user', async () => {
    const agg = await otelMetricsForUsers(['nobody'], now - 7 * 24 * 3600);
    expect(agg.activeTimeUserS).toBe(0);
    expect(agg.linesAdded).toBe(0);
  });

  it('excludes data points outside the window', async () => {
    await sql.run(
      `INSERT INTO code_otel_metrics (id, user_id, session_id, metric_name, value, type, occurred_at)
       VALUES ('old', ?, 'sess_agg', 'claude_code.pull_request.count', 5, NULL, ?)`,
      [USER, now - 40 * 24 * 3600],
    );
    const agg = await otelMetricsForUsers([USER], now - 7 * 24 * 3600);
    expect(agg.prCount).toBe(0);
  });
});

describe('runCodeHourlyAggregation writes OTel columns', () => {
  it('populates the new code_metrics columns for a user with metrics + a session', async () => {
    await sql.run(`INSERT INTO users (id, email, display_name, source, first_seen_at, last_seen_at)
                VALUES (?, 'agg@example.com', 'Agg', 'otel', ?, ?)`, [USER, recent, recent]);
    // A session_stats row so the user appears in the aggregation window.
    await sql.run(`INSERT INTO code_session_stats (session_id, user_id, first_at, last_at, computed_at)
                VALUES ('sess_agg', ?, ?, ?, ?)`, [USER, recent, recent, recent]);
    await seedMetric('claude_code.active_time.total', 900, 'user');
    await seedMetric('claude_code.lines_of_code.count', 250, 'added');
    await seedMetric('claude_code.pull_request.count', 3, null);

    await runCodeHourlyAggregation();

    const row = (await sql.get(
      `SELECT active_time_user_s, lines_added, pr_count FROM code_metrics
       WHERE scope_type='user' AND scope_id=? AND granularity='rolling' ORDER BY computed_at DESC LIMIT 1`,
      [USER],
    )) as { active_time_user_s: number; lines_added: number; pr_count: number };
    expect(row.active_time_user_s).toBe(900);
    expect(row.lines_added).toBe(250);
    expect(row.pr_count).toBe(3);
  });
});
