// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-surface spend consistency — a regression lock proving FinOps
 * (buildChargeback) computes the SAME dollar figures as the Pulse surfaces
 * for a fixed window, using the Pulse surfaces' own primitives:
 *
 *  - Work Pulse way: SUM(cost_usd) over cowork_api_request rows in range.
 *  - Developer Pulse way:   priceTokens() per (model) group over code_assistant_meta
 *                       in range, summed.
 *
 * If this test ever fails, buildChargeback has diverged from the Pulse
 * primitives — fix the engine to reuse them, not this test.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
// first_seen_at/last_seen_at for seeded users (bound as a parameter).
const SEED_NOW = Math.floor(Date.now() / 1000);
let buildChargeback: typeof import('@/lib/finance/chargeback').buildChargeback;
let priceTokens: typeof import('@/lib/pulse/code/rates').priceTokens;
let getCodeModelRates: typeof import('@/lib/pulse/code/rates').getCodeModelRates;

// Fixed March 2026 window, UTC epoch seconds.
const MARCH_15 = Math.floor(Date.UTC(2026, 2, 15) / 1000);
const MARCH_20 = Math.floor(Date.UTC(2026, 2, 20) / 1000);
const MARCH_START = Math.floor(Date.UTC(2026, 2, 1) / 1000);
const APRIL_START = Math.floor(Date.UTC(2026, 3, 1) / 1000);

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
  ({ buildChargeback } = await import('@/lib/finance/chargeback'));
  ({ priceTokens, getCodeModelRates } = await import('@/lib/pulse/code/rates'));

  // --- Users (department irrelevant to this test — we only check surface totals) ---
  await sql.run(
    `INSERT INTO users (id, email, display_name, source, department, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, 'otel', ?, ?, ?)`,
    ['u-a', 'a@test.com', 'User A', 'Engineering', SEED_NOW, SEED_NOW]);
  await sql.run(
    `INSERT INTO users (id, email, display_name, source, department, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, 'otel', ?, ?, ?)`,
    ['u-b', 'b@test.com', 'User B', 'Product', SEED_NOW, SEED_NOW]);

  // --- code_assistant_meta: multiple models, multiple users, multiple rows per (user, model) ---
  await sql.run(
    `INSERT INTO code_assistant_meta (id, session_id, user_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['cam-1', 'sess-1', 'u-a', 'claude-haiku-4-5', 1_000_000, 200_000, 0, 0, MARCH_15]);
  await sql.run(
    `INSERT INTO code_assistant_meta (id, session_id, user_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['cam-2', 'sess-2', 'u-a', 'claude-haiku-4-5', 500_000, 0, 100_000, 50_000, MARCH_20]);
  await sql.run(
    `INSERT INTO code_assistant_meta (id, session_id, user_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['cam-3', 'sess-3', 'u-b', 'claude-haiku-4-5-20251001', 2_000_000, 300_000, 0, 0, MARCH_15]);
  // Unpriced model — prices to null both here and in buildChargeback; excluded from both sums.
  await sql.run(
    `INSERT INTO code_assistant_meta (id, session_id, user_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['cam-4', 'sess-4', 'u-b', 'mystery-model-x', 1_000_000, 1_000_000, 0, 0, MARCH_15]);
  // Out-of-window row (February) — must be excluded from both sums.
  await sql.run(
    `INSERT INTO code_assistant_meta (id, session_id, user_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['cam-feb', 'sess-feb', 'u-a', 'claude-haiku-4-5', 9_000_000, 0, 0, 0, MARCH_START - 1]);
  // Out-of-window row (April) — must be excluded from both sums.
  await sql.run(
    `INSERT INTO code_assistant_meta (id, session_id, user_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['cam-apr', 'sess-apr', 'u-a', 'claude-haiku-4-5', 9_000_000, 0, 0, 0, APRIL_START]);

  // --- cowork_messages: cowork_api_request rows with cost_usd, plus noise ---
  await sql.run(
    `INSERT INTO cowork_messages (id, session_id, user_id, message_type, cost_usd, occurred_at)
     VALUES (?, ?, ?, 'cowork_api_request', ?, ?)`,
    ['cw-1', 'csess-1', 'u-a', 3.25, MARCH_15]);
  await sql.run(
    `INSERT INTO cowork_messages (id, session_id, user_id, message_type, cost_usd, occurred_at)
     VALUES (?, ?, ?, 'cowork_api_request', ?, ?)`,
    ['cw-2', 'csess-2', 'u-b', 1.10, MARCH_20]);
  // NULL cost_usd row — SUM/COALESCE must treat it as 0, not crash.
  await sql.run(
    `INSERT INTO cowork_messages (id, session_id, user_id, message_type, cost_usd, occurred_at)
     VALUES (?, ?, ?, 'cowork_api_request', NULL, ?)`,
    ['cw-3', 'csess-3', 'u-a', MARCH_15]);
  // Non-cowork_api_request row in-window — must be excluded from the Cowork sum (wrong message_type).
  await sql.run(
    `INSERT INTO cowork_messages (id, session_id, user_id, message_type, cost_usd, occurred_at)
     VALUES (?, ?, ?, 'cowork_user_message', ?, ?)`,
    ['cw-4', 'csess-4', 'u-a', 999, MARCH_15]);
  // Out-of-window cowork_api_request row — must be excluded.
  await sql.run(
    `INSERT INTO cowork_messages (id, session_id, user_id, message_type, cost_usd, occurred_at)
     VALUES (?, ?, ?, 'cowork_api_request', ?, ?)`,
    ['cw-apr', 'csess-apr', 'u-a', 42, APRIL_START]);
});

afterAll(async () => cleanup());

describe('FinOps == Pulse cross-surface spend consistency (fixed March 2026 window)', () => {
  it('report.surfaces.cowork.usd matches the Work Pulse SUM(cost_usd) primitive', async () => {
    // Independently computed, exactly the way Work Pulse computes it.
    const row = await sql.get(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total
         FROM cowork_messages
         WHERE message_type = 'cowork_api_request' AND occurred_at >= ? AND occurred_at < ?`,
        [MARCH_START, APRIL_START]) as { total: number };
    const pulseCoworkSum = row.total;

    // Sanity: this should equal 3.25 + 1.10 + 0 (null) = 4.35, excluding the
    // wrong-message_type row and the out-of-window April row.
    expect(pulseCoworkSum).toBeCloseTo(4.35, 6);

    const report = await buildChargeback('2026-03', MARCH_15);
    expect(report.surfaces.cowork.usd).not.toBeNull();
    expect(Math.abs(report.surfaces.cowork.usd! - pulseCoworkSum)).toBeLessThanOrEqual(0.005);
  });

  it('report.surfaces.code.usd matches the Developer Pulse priceTokens() primitive', async () => {
    // Independently computed, exactly the way Developer Pulse prices spend: group
    // by model, price each group's token totals, sum (skipping unpriced models).
    const rates = await getCodeModelRates();
    const rows = await sql.all(
        `SELECT model,
                SUM(input_tokens) AS i, SUM(output_tokens) AS o,
                SUM(cache_creation_tokens) AS cw, SUM(cache_read_tokens) AS cr
         FROM code_assistant_meta
         WHERE occurred_at >= ? AND occurred_at < ?
         GROUP BY model`,
        [MARCH_START, APRIL_START]) as Array<{
      model: string | null;
      i: number;
      o: number;
      cw: number;
      cr: number;
    }>;

    let pulseCodeSum = 0;
    for (const row of rows) {
      if (!row.model) continue;
      const usd = priceTokens(
        row.model,
        {
          inputTokens: row.i ?? 0,
          outputTokens: row.o ?? 0,
          cacheCreationTokens: row.cw ?? 0,
          cacheReadTokens: row.cr ?? 0,
        },
        rates
      );
      if (usd !== null) pulseCodeSum += usd;
    }

    // Sanity hand-check:
    //   cam-1: 1,000,000 in @ $1/MTok + 200,000 out @ $5/MTok = 1.00 + 1.00 = 2.00
    //   cam-2: 500,000 in @ $1 + 100,000 cacheWrite @ $1.25 + 50,000 cacheRead @ $0.10
    //        = 0.50 + 0.125 + 0.005 = 0.63
    //   cam-3: 2,000,000 in @ $1 + 300,000 out @ $5 (claude-haiku-4-5-20251001)
    //        = 2.00 + 1.50 = 3.50
    //   cam-4 (mystery-model-x): unpriced, contributes 0
    // Total = 2.00 + 0.63 + 3.50 = 6.13
    expect(pulseCodeSum).toBeCloseTo(6.13, 6);

    const report = await buildChargeback('2026-03', MARCH_15);
    expect(report.surfaces.code.usd).not.toBeNull();
    expect(Math.abs(report.surfaces.code.usd! - pulseCodeSum)).toBeLessThanOrEqual(0.005);
  });

  it('unpriced model is excluded from both figures identically (never silently priced at 0-as-real)', async () => {
    const report = await buildChargeback('2026-03', MARCH_15);
    expect(report.unpricedModels).toContain('mystery-model-x');
  });

  it('§5e: the Value page spend (grouped by user+model) equals the FinOps code spend (grouped by model)', async () => {
    // The Developer Pulse Value route prices spend grouped by (user_id, model) to feed
    // the Return-multiple denominator (annual_spend). FinOps/Developer Pulse group by
    // (model). priceTokens is linear per token at a constant per-model rate, so
    // both groupings MUST yield the identical dollar — this locks the Value page,
    // FinOps and Developer Pulse to one source of dollar truth (§5e). If it fails, the
    // Value route has grown a parallel spend calc — fix it to reuse the primitive.
    const rates = await getCodeModelRates();
    const priceRows = async (grouping: string) =>
      await sql.all(
        `SELECT ${grouping} AS gk, model,
                SUM(input_tokens) AS i, SUM(output_tokens) AS o,
                SUM(cache_creation_tokens) AS cw, SUM(cache_read_tokens) AS cr
         FROM code_assistant_meta
         WHERE occurred_at >= ? AND occurred_at < ?
         GROUP BY ${grouping}, model`,
        [MARCH_START, APRIL_START]) as Array<{ model: string | null; i: number; o: number; cw: number; cr: number }>;

    const sumPriced = (rows: Array<{ model: string | null; i: number; o: number; cw: number; cr: number }>) => {
      let total = 0;
      for (const r of rows) {
        if (!r.model) continue;
        const usd = priceTokens(r.model, { inputTokens: r.i ?? 0, outputTokens: r.o ?? 0, cacheCreationTokens: r.cw ?? 0, cacheReadTokens: r.cr ?? 0 }, rates);
        if (usd !== null) total += usd;
      }
      return total;
    };

    const valueWay = sumPriced(await priceRows('user_id')); // Value route: GROUP BY user_id, model
    const finopsWay = sumPriced(await priceRows('model'));   // FinOps/Code: GROUP BY model
    expect(valueWay).toBeCloseTo(finopsWay, 6);
    expect(valueWay).toBeCloseTo(6.13, 6);

    const report = await buildChargeback('2026-03', MARCH_15);
    expect(Math.abs(report.surfaces.code.usd! - valueWay)).toBeLessThanOrEqual(0.005);
  });
});
