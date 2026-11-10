// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// FinOps with department sync: a person the directory moved during an open
// month has their spend split at the move; everyone else is unchanged.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
let chargeback: typeof import('@/lib/finance/chargeback');

const NOW = Math.floor(Date.now() / 1000);
const day = (d: number) => Math.floor(Date.UTC(2026, 2, d, 12) / 1000); // March 2026

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
  chargeback = await import('@/lib/finance/chargeback');

  const user = (id: string, dept: string) => sql.run(
    `INSERT INTO users (id, email, display_name, source, department, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'otel', ?, ?, ?)`,
    [id, `${id}@example.com`, id, dept, NOW, NOW]);
  await user('u-mover', 'Finance');   // moved Legal → Finance on 15 March
  await user('u-stay', 'Legal');
  await user('u-manual', 'Sales');    // moved by the directory, then set by hand: not split

  const cowork = (id: string, userId: string, usd: number, at: number) => sql.run(
    `INSERT INTO cowork_messages (id, session_id, user_id, message_type, cost_usd, occurred_at) VALUES (?, ?, ?, 'cowork_api_request', ?, ?)`,
    [id, `s-${id}`, userId, usd, at]);
  await cowork('m1', 'u-mover', 2, day(5));
  await cowork('m2', 'u-mover', 3, day(25));
  await cowork('s1', 'u-stay', 4, day(10));
  await cowork('x1', 'u-manual', 1, day(5));
  await cowork('x2', 'u-manual', 1, day(25));
  // u-mover: 1,000,000 input tokens of claude-haiku-4-5 ($1) before the move.
  await sql.run(
    `INSERT INTO code_assistant_meta (id, session_id, user_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, occurred_at)
     VALUES ('c1', 'cs1', 'u-mover', 'claude-haiku-4-5', 1000000, 0, 0, 0, ?)`, [day(10)]);

  // Codex ($1 per million input tokens on gpt-6.1-terra): $1 before the move, $2 after.
  const codex = (id: string, tokens: number, at: number) => sql.run(
    `INSERT INTO codex_turns (id, user_id, session_id, model, started_at, uncached_input_tokens) VALUES (?, 'u-mover', ?, 'gpt-6.1-terra', ?, ?)`,
    [id, `codex:${id}`, at, tokens]);
  await codex('t1', 1_000_000, day(10));
  await codex('t2', 2_000_000, day(20));
  // ChatGPT cost records: $1 before the move, $1 after.
  const chatgpt = (id: string, at: number) => sql.run(
    `INSERT INTO openai_costs (id, user_id, hour_start, product, model, input_tokens, billed_in) VALUES (?, 'u-mover', ?, 'chatgpt', 'gpt-6.1-terra', 1000000, 'usd')`,
    [id, at]);
  await chatgpt('o1', day(8));
  await chatgpt('o2', day(22));

  const history = (id: string, userId: string, from: string | null, to: string, source: string, isMove: number, at: number) => sql.run(
    `INSERT INTO department_history (id, user_id, from_department, to_department, source, is_move, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, from, to, source, isMove, at]);
  await history('h1', 'u-mover', 'Legal', 'Finance', 'directory', 1, day(15));
  await history('h2', 'u-manual', 'Legal', 'Ops', 'directory', 1, day(15));
  await history('h3', 'u-manual', 'Ops', 'Sales', 'manual', 0, day(20));
});

afterAll(async () => cleanup());

describe('a department move during an open month', () => {
  it('counts spend before the move to the old department and after it to the new one', async () => {
    const report = await chargeback.buildChargeback('2026-03', NOW);
    const legal = report.costCentres.find(c => c.name === 'Legal')!;
    const finance = report.costCentres.find(c => c.name === 'Finance')!;
    const moverLegal = legal.users.find(u => u.userId === 'u-mover')!;
    const moverFinance = finance.users.find(u => u.userId === 'u-mover')!;

    expect(moverLegal.coworkUsd).toBeCloseTo(2, 6);
    expect(moverLegal.codeUsd).toBeCloseTo(1, 6);
    expect(moverLegal.codexUsd).toBeCloseTo(1, 6);
    expect(moverLegal.chatgptUsd).toBeCloseTo(1, 6);
    expect(moverLegal.totalUsd).toBeCloseTo(5, 6);
    expect(moverLegal.tokens.input).toBe(1_000_000);
    expect(moverFinance.coworkUsd).toBeCloseTo(3, 6);
    expect(moverFinance.codeUsd).toBeCloseTo(0, 6);
    expect(moverFinance.codexUsd).toBeCloseTo(2, 6);
    expect(moverFinance.chatgptUsd).toBeCloseTo(1, 6);
    expect(moverFinance.totalUsd).toBeCloseTo(6, 6);
    expect(moverFinance.tokens.input).toBe(0);
    expect(legal.totalUsd).toBeCloseTo(9, 6); // mover's $5 + u-stay's $4
  });

  it('leaves the total unchanged and shows the person once on the leaderboard', async () => {
    const report = await chargeback.buildChargeback('2026-03', NOW);
    expect(report.grandTotalUsd).toBeCloseTo(17, 6);
    const entries = report.leaderboard.filter(e => e.userId === 'u-mover');
    expect(entries).toHaveLength(1);
    expect(entries[0].totalUsd).toBeCloseTo(11, 6);
  });

  it('does not split a person whose department was also set by hand that month', async () => {
    const report = await chargeback.buildChargeback('2026-03', NOW);
    const parts = report.costCentres.flatMap(c => c.users.filter(u => u.userId === 'u-manual').map(u => ({ centre: c.name, usd: u.totalUsd })));
    expect(parts).toEqual([{ centre: 'Sales', usd: 2 }]);
  });
});

describe('mergeUsersById', () => {
  it("adds a person's parts back into one entry", () => {
    const part = (usd: number) => ({ userId: 'u', displayName: 'U', codeUsd: usd, coworkUsd: 0, totalUsd: usd, tokens: { input: usd, output: 0, cacheWrite: 0, cacheRead: 0 } });
    expect(chargeback.mergeUsersById([part(1), part(2), { ...part(5), userId: 'v' }])).toEqual([
      { userId: 'u', displayName: 'U', codeUsd: 3, coworkUsd: 0, totalUsd: 3, tokens: { input: 3, output: 0, cacheWrite: 0, cacheRead: 0 } },
      { userId: 'v', displayName: 'U', codeUsd: 5, coworkUsd: 0, totalUsd: 5, tokens: { input: 5, output: 0, cacheWrite: 0, cacheRead: 0 } },
    ]);
  });
});
