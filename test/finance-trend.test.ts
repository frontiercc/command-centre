// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
// first_seen_at/last_seen_at for seeded users (bound as a parameter).
const SEED_NOW = Math.floor(Date.now() / 1000);
let buildSpendTrend: typeof import('@/lib/finance/trend').buildSpendTrend;

// Fixed "now" inside March 2026 — the trend window ends here.
const MARCH_15 = Math.floor(Date.UTC(2026, 2, 15) / 1000);
const JAN_15 = Math.floor(Date.UTC(2026, 0, 15) / 1000);
const FEB_15 = Math.floor(Date.UTC(2026, 1, 15) / 1000);

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
  buildSpendTrend = (await import('@/lib/finance/trend')).buildSpendTrend;

  await sql.run(
    `INSERT INTO users (id, email, display_name, source, department, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, 'otel', ?, ?, ?)`,
    ['u-1', 'u1@test.com', 'User One', 'Legal', SEED_NOW, SEED_NOW]);

  // Spend in three distinct months: Jan, Feb, Mar 2026 — $1.00 each
  // (1,000,000 input tokens of claude-haiku-4-5 @ $1/MTok in).
  await sql.run(
    `INSERT INTO code_assistant_meta (id, session_id, user_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['cam-jan', 'sess-jan', 'u-1', 'claude-haiku-4-5', 1_000_000, 0, 0, 0, JAN_15]);
  await sql.run(
    `INSERT INTO code_assistant_meta (id, session_id, user_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['cam-feb', 'sess-feb', 'u-1', 'claude-haiku-4-5', 1_000_000, 0, 0, 0, FEB_15]);
  await sql.run(
    `INSERT INTO code_assistant_meta (id, session_id, user_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['cam-mar', 'sess-mar', 'u-1', 'claude-haiku-4-5', 1_000_000, 0, 0, 0, MARCH_15]);
});

afterAll(async () => cleanup());

describe('buildSpendTrend', () => {
  it('builds 12 months ending at the current period, seeded months correct, render=true when >=3 months have spend', async () => {
    const trend = await buildSpendTrend(MARCH_15, 12);

    expect(trend.series).toHaveLength(12);
    expect(trend.series[trend.series.length - 1].period).toBe('2026-03');
    expect(trend.series[0].period).toBe('2025-04'); // 12 months back from 2026-03 inclusive

    const jan = trend.series.find(p => p.period === '2026-01')!;
    const feb = trend.series.find(p => p.period === '2026-02')!;
    const mar = trend.series.find(p => p.period === '2026-03')!;
    expect(jan.usd).not.toBeNull();
    expect(jan.usd!).toBeCloseTo(1.0, 6);
    expect(feb.usd).not.toBeNull();
    expect(feb.usd!).toBeCloseTo(1.0, 6);
    expect(mar.usd).not.toBeNull();
    expect(mar.usd!).toBeCloseTo(1.0, 6);

    // Empty months are 0 (not null) — buildChargeback always returns a real number.
    const dec = trend.series.find(p => p.period === '2025-12')!;
    expect(dec.usd).toBe(0);

    expect(trend.render).toBe(true);
  });

  it('render=false when fewer than 3 months have spend', async () => {
    const trend = await buildSpendTrend(JAN_15, 12);
    // Only January has spend in this window (Feb/Mar are in the future relative to JAN_15,
    // and buildChargeback for those periods will be 0 since occurred_at rows are in the future).
    const monthsWithSpend = trend.series.filter(p => (p.usd ?? 0) > 0).length;
    expect(monthsWithSpend).toBeLessThan(3);
    expect(trend.render).toBe(false);
  });
});
