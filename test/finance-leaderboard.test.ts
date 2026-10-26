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

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
  buildChargeback = (await import('@/lib/finance/chargeback')).buildChargeback;

  // --- Users ---
  // Two in Legal, one in Finance, one with NULL department (unallocated),
  // one zero-spend user who must never appear in the leaderboard.
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
  // Zero-spend user — present in `users` but no code/cowork rows at all.
  await sql.run(
    `INSERT INTO users (id, email, display_name, source, department, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, 'otel', ?, ?, ?)`,
    ['u-zero', 'zero@test.com', 'Zero Spend', 'Legal', SEED_NOW, SEED_NOW]);

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

  // u-nodept: 100,000 input tokens of claude-haiku-4-5 = $0.10 (unallocated bucket)
  await sql.run(
    `INSERT INTO code_assistant_meta (id, session_id, user_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['cam-4', 'sess-4', 'u-nodept', 'claude-haiku-4-5', 100_000, 0, 0, 0, MARCH_15]);

  // --- cowork_messages (cowork_api_request) ---
  // u-legal-1: cowork $2.50 (highest total spender: 1.00 + 2.50 = 3.50)
  await sql.run(
    `INSERT INTO cowork_messages (id, session_id, user_id, message_type, cost_usd, occurred_at)
     VALUES (?, ?, ?, 'cowork_api_request', ?, ?)`,
    ['cw-1', 'csess-1', 'u-legal-1', 2.5, MARCH_15]);
});

afterAll(async () => cleanup());

describe('buildChargeback — leaderboard', () => {
  it('ranks the highest total-spend user first, sorted DESC, length <= 10, zero-spend user excluded', async () => {
    const report = await buildChargeback('2026-03', MARCH_15);

    expect(report.leaderboard.length).toBeLessThanOrEqual(10);
    // u-legal-1: code $1.00 + cowork $2.50 = $3.50 — the highest spender.
    expect(report.leaderboard[0].userId).toBe('u-legal-1');
    expect(report.leaderboard[0].totalUsd).toBeCloseTo(3.5, 6);

    // Sorted DESC.
    for (let i = 1; i < report.leaderboard.length; i++) {
      expect(report.leaderboard[i - 1].totalUsd).toBeGreaterThanOrEqual(report.leaderboard[i].totalUsd);
    }

    // Zero-spend user never appears.
    expect(report.leaderboard.some(u => u.userId === 'u-zero')).toBe(false);
  });

  it('leaderboard totals are single-source: they equal the user total in their centre/unallocated bucket', async () => {
    const report = await buildChargeback('2026-03', MARCH_15);

    for (const entry of report.leaderboard) {
      const inCentre = report.costCentres
        .flatMap(c => c.users)
        .find(u => u.userId === entry.userId);
      const inUnallocated = report.unallocated.users.find(u => u.userId === entry.userId);
      const source = inCentre ?? inUnallocated;

      expect(source).toBeDefined();
      expect(entry.totalUsd).toBeCloseTo(source!.totalUsd, 6);
      expect(entry.codeUsd).toBeCloseTo(source!.codeUsd, 6);
      expect(entry.coworkUsd).toBeCloseTo(source!.coworkUsd, 6);
      expect(entry.displayName).toBe(source!.displayName);
    }

    // The unallocated (no-dept) user's leaderboard entry matches too.
    const noDeptEntry = report.leaderboard.find(u => u.userId === 'u-nodept');
    expect(noDeptEntry).toBeDefined();
    expect(noDeptEntry!.totalUsd).toBeCloseTo(0.1, 6);
  });
});
