// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// FinOps with the OpenAI export connected (lib/finance/chargeback.ts):
// ChatGPT and Codex spend priced from tokens at OpenAI's USD rates, added to
// each person's and cost centre's total, with a Claude / OpenAI split. A
// Claude-only install's report is unchanged (no vendors, no OpenAI fields).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
let buildChargeback: typeof import('@/lib/finance/chargeback').buildChargeback;

const NOW = Math.floor(Date.now() / 1000);
const MARCH_15 = Math.floor(Date.UTC(2026, 2, 15) / 1000);
const APRIL_2 = Math.floor(Date.UTC(2026, 3, 2) / 1000);

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
  buildChargeback = (await import('@/lib/finance/chargeback')).buildChargeback;

  const user = (id: string, source: string, dept: string | null) => sql.run(
    `INSERT INTO users (id, email, display_name, source, department, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, `${id}@test.local`, id, source, dept, NOW, NOW]);
  await user('u-claude', 'otel', 'Legal');
  await user('u-openai', 'openai', 'Legal');
  await user('u-nodept', 'openai', null);

  // Claude Code: 1M input tokens of claude-haiku-4-5 ($1/MTok in) = $1.00.
  await sql.run(
    `INSERT INTO code_assistant_meta (id, session_id, user_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, occurred_at)
     VALUES ('cam-1', 's-1', 'u-claude', 'claude-haiku-4-5', 1000000, 0, 0, 0, ?)`, [MARCH_15]);
});

afterAll(async () => cleanup());

describe('buildChargeback with OpenAI', () => {
  it('a Claude-only install carries no OpenAI fields', async () => {
    const r = await buildChargeback('2026-03', NOW);
    expect(r.grandTotalUsd).toBeCloseTo(1, 5);
    expect(r.vendors).toBeUndefined();
    expect(r.openaiUnpricedModels).toBeUndefined();
    expect(r.surfaces.chatgpt).toBeUndefined();
    expect(r.costCentres[0].users[0]).not.toHaveProperty('chatgptUsd');
  });

  it('adds ChatGPT and Codex to people, centres and the total, with a Claude / OpenAI split', async () => {
    // ChatGPT: 1M input tokens of gpt-6.1-terra ($1/MTok in) = $1.00. OpenAI's own figure is ignored.
    await sql.run(
      `INSERT INTO openai_costs (id, user_id, hour_start, product, model, input_tokens, cached_input_tokens, output_tokens, cost_usd, billed_in)
       VALUES ('oc-1', 'u-openai', ?, 'chatgpt', 'gpt-6.1-terra', 1000000, 0, 0, 9.99, 'usd')`, [MARCH_15]);
    // Codex cost records are left out: Codex is priced per turn.
    await sql.run(
      `INSERT INTO openai_costs (id, user_id, hour_start, product, model, input_tokens, cached_input_tokens, output_tokens, cost_usd, billed_in)
       VALUES ('oc-2', 'u-openai', ?, 'codex', 'gpt-6.1-terra', 5000000, 0, 0, 5, 'usd')`, [MARCH_15]);
    // Outside the month.
    await sql.run(
      `INSERT INTO openai_costs (id, user_id, hour_start, product, model, input_tokens, cached_input_tokens, output_tokens, cost_usd, billed_in)
       VALUES ('oc-3', 'u-openai', ?, 'chatgpt', 'gpt-6.1-terra', 7000000, 0, 0, 7, 'usd')`, [APRIL_2]);
    // Codex: 200k output tokens of gpt-6.1-terra ($5/MTok out) = $1.00.
    await sql.run(
      `INSERT INTO codex_turns (id, user_id, session_id, model, started_at, uncached_input_tokens, cached_input_tokens, output_tokens)
       VALUES ('ct-1', 'u-openai', 'codex:s1', 'gpt-6.1-terra', ?, 0, 0, 200000)`, [MARCH_15]);
    // An unpriced Codex model: named, never counted.
    await sql.run(
      `INSERT INTO codex_turns (id, user_id, session_id, model, started_at, uncached_input_tokens, cached_input_tokens, output_tokens)
       VALUES ('ct-2', 'u-nodept', 'codex:s2', 'mystery-codex', ?, 1000000, 0, 1000000)`, [MARCH_15]);

    const r = await buildChargeback('2026-03', NOW);
    expect(r.grandTotalUsd).toBeCloseTo(3, 5);
    expect(r.vendors?.claudeUsd).toBeCloseTo(1, 5);
    expect(r.vendors?.openaiUsd).toBeCloseTo(2, 5);
    expect(r.openaiUnpricedModels).toEqual(['mystery-codex']);
    expect(r.unpricedModels).toEqual([]);

    const legal = r.costCentres.find(c => c.name === 'Legal')!;
    expect(legal.totalUsd).toBeCloseTo(3, 5);
    expect(legal.chatgptUsd).toBeCloseTo(1, 5);
    expect(legal.codexUsd).toBeCloseTo(1, 5);
    const person = legal.users.find(u => u.userId === 'u-openai')!;
    expect(person.chatgptUsd).toBeCloseTo(1, 5);
    expect(person.codexUsd).toBeCloseTo(1, 5);
    expect(person.totalUsd).toBeCloseTo(2, 5);
    // A Claude user shows zero OpenAI spend, not a missing field.
    expect(legal.users.find(u => u.userId === 'u-claude')!.chatgptUsd).toBe(0);

    // The person with only unpriced usage is still listed under Unallocated, at $0.
    expect(r.unallocated.users.map(u => u.userId)).toEqual(['u-nodept']);
    expect(r.unallocated.totalUsd).toBe(0);

    expect(r.surfaces.chatgpt).toMatchObject({ basis: 'openai_rates' });
    expect(r.surfaces.chatgpt!.usd).toBeCloseTo(1, 5);
    expect(r.surfaces.codex!.usd).toBeCloseTo(1, 5);
    expect(r.surfaces.total.usd).toBeCloseTo(3, 5);
    // Claude's own tokens are unchanged by OpenAI's.
    expect(r.codeTokens.input).toBe(1_000_000);

    const top = r.leaderboard.find(e => e.userId === 'u-openai')!;
    expect(top).toMatchObject({ codeUsd: 0, coworkUsd: 0 });
    expect(top.chatgptUsd).toBeCloseTo(1, 5);
    expect(top.codexUsd).toBeCloseTo(1, 5);
  });

  it('a month with no OpenAI usage still shows the OpenAI parts, at zero', async () => {
    const r = await buildChargeback('2026-02', NOW);
    expect(r.vendors).toEqual({ claudeUsd: 0, openaiUsd: 0 });
    expect(r.surfaces.chatgpt!.usd).toBe(0);
    expect(r.surfaces.codex!.usd).toBe(0);
  });
});
