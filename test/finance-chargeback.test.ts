// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
// first_seen_at/last_seen_at for seeded users (bound as a parameter).
const SEED_NOW = Math.floor(Date.now() / 1000);
let buildChargeback: typeof import('@/lib/finance/chargeback').buildChargeback;

// March 2026 window, UTC epoch seconds.
const MARCH_15 = Math.floor(Date.UTC(2026, 2, 15) / 1000);
// April 2026 window — isolated so cache-read seeding can't disturb March totals.
const APRIL_15 = Math.floor(Date.UTC(2026, 3, 15) / 1000);

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
  buildChargeback = (await import('@/lib/finance/chargeback')).buildChargeback;

  // --- Users ---
  // Two in Legal, one in Finance, one with NULL department.
  await sql.run(
    `INSERT INTO users (id, email, display_name, source, department, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, 'otel', ?, ?, ?)`,
    ['u-legal-1', 'legal1@test.com', 'Legal One', 'Legal', SEED_NOW, SEED_NOW]);
  await sql.run(
    `INSERT INTO users (id, email, display_name, source, department, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, 'otel', ?, ?, ?)`,
    ['u-legal-2', 'legal2@test.com', 'Legal Two', 'Legal', SEED_NOW, SEED_NOW]);
  await sql.run(
    `INSERT INTO users (id, email, display_name, source, department, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, 'otel', ?, ?, ?)`,
    ['u-fin-1', 'fin1@test.com', 'Finance One', 'Finance', SEED_NOW, SEED_NOW]);
  await sql.run(
    `INSERT INTO users (id, email, display_name, source, department, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, 'otel', ?, ?, ?)`,
    ['u-nodept', 'nodept@test.com', 'No Dept', null, SEED_NOW, SEED_NOW]);

  // --- code_assistant_meta ---
  // u-legal-1: 1,000,000 input tokens of claude-haiku-4-5 ($1/MTok in) = $1.00
  await sql.run(
    `INSERT INTO code_assistant_meta (id, session_id, user_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['cam-1', 'sess-1', 'u-legal-1', 'claude-haiku-4-5', 1_000_000, 0, 0, 0, MARCH_15]);

  // u-legal-2: 200,000 output tokens of claude-haiku-4-5 ($5/MTok out) = $1.00
  await sql.run(
    `INSERT INTO code_assistant_meta (id, session_id, user_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['cam-2', 'sess-2', 'u-legal-2', 'claude-haiku-4-5', 0, 200_000, 0, 0, MARCH_15]);

  // u-fin-1: 500,000 input tokens of claude-haiku-4-5 = $0.50
  await sql.run(
    `INSERT INTO code_assistant_meta (id, session_id, user_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['cam-3', 'sess-3', 'u-fin-1', 'claude-haiku-4-5', 500_000, 0, 0, 0, MARCH_15]);

  // u-nodept: unknown model 'mystery-x' — unpriced, contributes $0 but must appear in unpricedModels.
  await sql.run(
    `INSERT INTO code_assistant_meta (id, session_id, user_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['cam-4', 'sess-4', 'u-nodept', 'mystery-x', 1_000_000, 1_000_000, 0, 0, MARCH_15]);

  // u-nodept also has some priced code spend so it's not entirely zero.
  await sql.run(
    `INSERT INTO code_assistant_meta (id, session_id, user_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['cam-5', 'sess-4', 'u-nodept', 'claude-haiku-4-5', 100_000, 0, 0, 0, MARCH_15]);
  // = $0.10

  // --- cowork_messages (cowork_api_request) ---
  await sql.run(
    `INSERT INTO cowork_messages (id, session_id, user_id, message_type, cost_usd, occurred_at)
     VALUES (?, ?, ?, 'cowork_api_request', ?, ?)`,
    ['cw-1', 'csess-1', 'u-legal-1', 2.5, MARCH_15]);
  await sql.run(
    `INSERT INTO cowork_messages (id, session_id, user_id, message_type, cost_usd, occurred_at)
     VALUES (?, ?, ?, 'cowork_api_request', ?, ?)`,
    ['cw-2', 'csess-2', 'u-fin-1', 1.25, MARCH_15]);
  // NULL cost_usd row — exercises coverage figure (and should not crash the SUM).
  await sql.run(
    `INSERT INTO cowork_messages (id, session_id, user_id, message_type, cost_usd, occurred_at)
     VALUES (?, ?, ?, 'cowork_api_request', NULL, ?)`,
    ['cw-3', 'csess-3', 'u-legal-2', MARCH_15]);

  // --- April: a cache-read-heavy row (isolated from March totals) ---
  // 10,000,000 cache-read tokens of claude-haiku-4-5 (cacheRead = 0.1×in = $0.10/MTok)
  //   → priced spend = 10 × 0.10 = $1.00
  //   → cache savings vs full input (in − cacheRead = 1 − 0.1 = $0.90/MTok) = 10 × 0.90 = $9.00
  await sql.run(
    `INSERT INTO code_assistant_meta (id, session_id, user_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['cam-apr-1', 'sess-apr', 'u-legal-1', 'claude-haiku-4-5', 0, 0, 0, 10_000_000, APRIL_15]);
});

afterAll(async () => cleanup());

describe('buildChargeback', () => {
  it('groups spend by department and computes correct dollar totals', async () => {
    const report = await buildChargeback('2026-03', MARCH_15);

    expect(report.period).toBe('2026-03');
    // nowS (MARCH_15) falls within the '2026-03' period itself.
    expect(report.monthToDate).toBe(true);

    const legal = report.costCentres.find(c => c.name === 'Legal')!;
    expect(legal).toBeDefined();
    // u-legal-1: code $1.00 + cowork $2.50 = $3.50
    // u-legal-2: code $1.00 + cowork $0 (null cost) = $1.00
    expect(legal.codeUsd).toBeCloseTo(2.0, 6);
    expect(legal.coworkUsd).toBeCloseTo(2.5, 6);
    expect(legal.totalUsd).toBeCloseTo(4.5, 6);
    expect(legal.users).toHaveLength(2);
    // Sorted by totalUsd DESC
    expect(legal.users[0].userId).toBe('u-legal-1');
    expect(legal.users[0].totalUsd).toBeCloseTo(3.5, 6);
    expect(legal.users[1].userId).toBe('u-legal-2');
    expect(legal.users[1].totalUsd).toBeCloseTo(1.0, 6);

    const finance = report.costCentres.find(c => c.name === 'Finance')!;
    expect(finance).toBeDefined();
    // u-fin-1: code $0.50 + cowork $1.25 = $1.75
    expect(finance.codeUsd).toBeCloseTo(0.5, 6);
    expect(finance.coworkUsd).toBeCloseTo(1.25, 6);
    expect(finance.totalUsd).toBeCloseTo(1.75, 6);
    expect(finance.users).toHaveLength(1);
  });

  it('buckets the NULL-department user under unallocated', async () => {
    const report = await buildChargeback('2026-03', MARCH_15);
    expect(report.costCentres.some(c => c.name === 'Legal' || c.name === 'Finance')).toBe(true);
    expect(report.costCentres.some(c => c.name === 'Unallocated')).toBe(false);

    const noDeptUser = report.unallocated.users.find(u => u.userId === 'u-nodept');
    expect(noDeptUser).toBeDefined();
    // code: mystery-x prices to null (contributes 0) + $0.10 priced = $0.10; cowork: 0.
    expect(noDeptUser!.codeUsd).toBeCloseTo(0.1, 6);
    expect(noDeptUser!.coworkUsd).toBeCloseTo(0, 6);
    expect(noDeptUser!.totalUsd).toBeCloseTo(0.1, 6);
  });

  it('flags the unknown model as unpriced', async () => {
    const report = await buildChargeback('2026-03', MARCH_15);
    expect(report.unpricedModels).toContain('mystery-x');
  });

  it('reconciles grandTotalUsd against the sum of centres + unallocated (within 0.005)', async () => {
    const report = await buildChargeback('2026-03', MARCH_15);
    const sumCentres = report.costCentres.reduce((s, c) => s + c.totalUsd, 0);
    const total = sumCentres + report.unallocated.totalUsd;
    expect(Math.abs(report.grandTotalUsd - total)).toBeLessThanOrEqual(0.005);
    // Hand-computed grand total: 3.5 + 1.0 + 1.75 + 0.1 = 6.35
    expect(report.grandTotalUsd).toBeCloseTo(6.35, 6);
  });

  it('reports cowork cost coverage reflecting the NULL cost_usd row', async () => {
    const report = await buildChargeback('2026-03', MARCH_15);
    expect(report.coworkCostCoverage.total).toBe(3);
    expect(report.coworkCostCoverage.withCost).toBe(2);
    expect(report.coworkCostCoverage.total).toBeGreaterThan(report.coworkCostCoverage.withCost);
  });

  it('returns empty costCentres/unallocated and a zero grand total for a period with no spend', async () => {
    const report = await buildChargeback('2020-01', MARCH_15);
    expect(report.costCentres).toEqual([]);
    expect(report.unallocated.users).toEqual([]);
    expect(report.grandTotalUsd).toBe(0);
    expect(report.coworkCostCoverage.total).toBe(0);
    expect(report.coworkCostCoverage.withCost).toBe(0);
    expect(report.monthToDate).toBe(false);
    // Tokens zeroed, cache-savings a real 0 (not null) when there is no code data.
    expect(report.codeTokens).toEqual({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
    expect(report.cacheSavingsUsd).toBe(0);
  });
});

describe('buildChargeback — token breakdown + cache savings', () => {
  it('reports exact org-total token counts including unpriced-model tokens (March)', async () => {
    const report = await buildChargeback('2026-03', MARCH_15);
    // input: 1,000,000 (cam-1) + 500,000 (cam-3) + 1,000,000 (cam-4 mystery-x, unpriced) + 100,000 (cam-5)
    expect(report.codeTokens.input).toBe(2_600_000);
    // output: 200,000 (cam-2) + 1,000,000 (cam-4 mystery-x, unpriced)
    expect(report.codeTokens.output).toBe(1_200_000);
    expect(report.codeTokens.cacheWrite).toBe(0);
    expect(report.codeTokens.cacheRead).toBe(0);
  });

  it('attributes token usage per user, including unpriced-model tokens', async () => {
    const report = await buildChargeback('2026-03', MARCH_15);
    const legal1 = report.costCentres
      .find(c => c.name === 'Legal')!
      .users.find(u => u.userId === 'u-legal-1')!;
    // cam-1: 1,000,000 input tokens of haiku.
    expect(legal1.tokens).toEqual({ input: 1_000_000, output: 0, cacheWrite: 0, cacheRead: 0 });

    const noDept = report.unallocated.users.find(u => u.userId === 'u-nodept')!;
    // cam-4 mystery-x (unpriced): in 1,000,000 / out 1,000,000  +  cam-5 haiku: in 100,000.
    // Tokens are attributed even though mystery-x priced to null.
    expect(noDept.tokens).toEqual({ input: 1_100_000, output: 1_000_000, cacheWrite: 0, cacheRead: 0 });
  });

  it('computes cache savings as a list-rate estimate and NEVER folds it into the total (April)', async () => {
    const report = await buildChargeback('2026-04', APRIL_15);
    expect(report.codeTokens.cacheRead).toBe(10_000_000);
    expect(report.codeTokens.input).toBe(0);
    // priced spend is just the cache-read cost: 10 × $0.10 = $1.00
    expect(report.grandTotalUsd).toBeCloseTo(1.0, 6);
    // savings = 10,000,000 × (1 − 0.1)/1e6 = $9.00 — informational, NOT part of the total
    expect(report.cacheSavingsUsd).not.toBeNull();
    expect(report.cacheSavingsUsd!).toBeCloseTo(9.0, 6);
    expect(report.cacheSavingsUsd!).toBeGreaterThan(report.grandTotalUsd);
  });
});
