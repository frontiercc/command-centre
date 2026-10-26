// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
// first_seen_at/last_seen_at for seeded users (bound parameters).
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
  await sql.run(
    `INSERT INTO users (id, email, display_name, source, department, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, 'otel', ?, ?, ?)`,
    ['u-legal-1', 'legal1@test.com', 'Legal One', 'Legal', SEED_NOW, SEED_NOW]);
  await sql.run(
    `INSERT INTO users (id, email, display_name, source, department, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, 'otel', ?, ?, ?)`,
    ['u-fin-1', 'fin1@test.com', 'Finance One', 'Finance', SEED_NOW, SEED_NOW]);

  // --- code_assistant_meta (haiku, priced) ---
  // u-legal-1: 1,000,000 input tokens of claude-haiku-4-5 ($1/MTok in) = $1.00
  await sql.run(
    `INSERT INTO code_assistant_meta (id, session_id, user_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['cam-1', 'sess-1', 'u-legal-1', 'claude-haiku-4-5', 1_000_000, 0, 0, 0, MARCH_15]);

  // u-fin-1: 200,000 output tokens of claude-haiku-4-5 ($5/MTok out) = $1.00
  await sql.run(
    `INSERT INTO code_assistant_meta (id, session_id, user_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['cam-2', 'sess-2', 'u-fin-1', 'claude-haiku-4-5', 0, 200_000, 0, 0, MARCH_15]);

  // --- cowork_messages (cowork_api_request) with token_usage JSON ---
  await sql.run(
    `INSERT INTO cowork_messages (id, session_id, user_id, message_type, cost_usd, token_usage, occurred_at)
     VALUES (?, ?, ?, 'cowork_api_request', ?, ?, ?)`,
    ['cw-1',
    'csess-1',
    'u-legal-1',
    2.5,
    JSON.stringify({ inputTokens: 10_000, outputTokens: 2_000, cacheReadTokens: 500, cacheCreationTokens: 100 }),
    MARCH_15]);
  await sql.run(
    `INSERT INTO cowork_messages (id, session_id, user_id, message_type, cost_usd, token_usage, occurred_at)
     VALUES (?, ?, ?, 'cowork_api_request', ?, ?, ?)`,
    ['cw-2',
    'csess-2',
    'u-fin-1',
    1.25,
    JSON.stringify({ inputTokens: 5_000, outputTokens: 1_000, cacheReadTokens: 0, cacheCreationTokens: 0 }),
    MARCH_15]);
  // Malformed token_usage — must be skipped, never thrown. The jsonb column
  // rejects invalid JSON outright, so the nearest storable "malformed" value
  // is a bare JSON string, which the engine's non-object guard skips.
  await sql.run(
    `INSERT INTO cowork_messages (id, session_id, user_id, message_type, cost_usd, token_usage, occurred_at)
     VALUES (?, ?, ?, 'cowork_api_request', ?, ?, ?)`,
    ['cw-3', 'csess-3', 'u-legal-1', 0.5,
      JSON.stringify('not-json{{{'), MARCH_15]);
  // NULL token_usage — must be skipped (guard), and NULL cost_usd should not break the SUM.
  await sql.run(
    `INSERT INTO cowork_messages (id, session_id, user_id, message_type, cost_usd, token_usage, occurred_at)
     VALUES (?, ?, ?, 'cowork_api_request', NULL, NULL, ?)`,
    ['cw-4', 'csess-4', 'u-fin-1', MARCH_15]);
});

afterAll(async () => cleanup());

describe('buildChargeback — surfaces (Chat/Code/Cowork)', () => {
  it('code surface: basis=estimate, usd equals priced sum, tokens equal codeTokens', async () => {
    const report = await buildChargeback('2026-03', MARCH_15);
    // cam-1: $1.00 (1,000,000 input @ $1/MTok) + cam-2: $1.00 (200,000 output @ $5/MTok) = $2.00
    expect(report.surfaces.code.basis).toBe('estimate');
    expect(report.surfaces.code.usd).toBeCloseTo(2.0, 6);
    expect(report.surfaces.code.tokens).toEqual(report.codeTokens);
    expect(report.surfaces.code.tokens).toEqual({ input: 1_000_000, output: 200_000, cacheWrite: 0, cacheRead: 0 });
  });

  it('cowork surface: basis=actual, usd equals SUM(cost_usd), tokens summed from token_usage (malformed/null skipped)', async () => {
    const report = await buildChargeback('2026-03', MARCH_15);
    // cw-1: 2.5 + cw-2: 1.25 + cw-3: 0.5 + cw-4: NULL(0) = 4.25
    expect(report.surfaces.cowork.basis).toBe('actual');
    expect(report.surfaces.cowork.usd).toBeCloseTo(4.25, 6);
    // Only cw-1 + cw-2 have valid token_usage JSON (cw-3 malformed, cw-4 null — both skipped).
    expect(report.surfaces.cowork.tokens).toEqual({
      input: 15_000,
      output: 3_000,
      cacheWrite: 100,
      cacheRead: 500,
    });
  });

  it('chat surface is exactly the dormant placeholder', async () => {
    const report = await buildChargeback('2026-03', MARCH_15);
    expect(report.surfaces.chat).toEqual({
      usd: null,
      tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      basis: 'dormant',
    });
  });

  it('total.usd/tokens = code + cowork, and reconciles with grandTotalUsd', async () => {
    const report = await buildChargeback('2026-03', MARCH_15);
    expect(report.surfaces.total.usd).toBeCloseTo(
      report.surfaces.code.usd! + report.surfaces.cowork.usd!,
      6
    );
    expect(report.surfaces.total.usd).toBeCloseTo(report.grandTotalUsd, 6);
    expect(report.surfaces.total.tokens).toEqual({
      input: report.surfaces.code.tokens.input + report.surfaces.cowork.tokens.input,
      output: report.surfaces.code.tokens.output + report.surfaces.cowork.tokens.output,
      cacheWrite: report.surfaces.code.tokens.cacheWrite + report.surfaces.cowork.tokens.cacheWrite,
      cacheRead: report.surfaces.code.tokens.cacheRead + report.surfaces.cowork.tokens.cacheRead,
    });
  });
});
