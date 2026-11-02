// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Report figures per product (ChatGPT and Codex never counted under a Claude
// name), alerts labelled by product, and the GDPR export carrying a person's
// ChatGPT and Codex records.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
const NOW = Math.floor(Date.now() / 1000);

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
  await sql.run(`INSERT INTO users (id, email) VALUES ('u1', 'u1@test.local')`);
  const msg = (id: string, surface: string, source: string | null, type: string, flagged = 0, at = NOW - 3600) => sql.run(
    `INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, flagged, occurred_at) VALUES (?, ?, 'u1', ?, ?, ?, ?, ?)`,
    [id, `s-${id}`, type, surface, source, flagged, at]);
  await msg('c1', 'cowork', 'otel', 'cowork_user_message');
  await msg('c2', 'cowork', 'otel', 'cowork_api_request');            // not a prompt
  await msg('g1', 'cowork', 'chatgpt_chat', 'cowork_user_message', 1);
  await msg('g2', 'cowork', 'chatgpt_work', 'cowork_user_message');
  await msg('x1', 'code', 'codex', 'code_user_message', 0, NOW - 10 * 86400);
  await msg('k1', 'code', 'otel', 'code_user_message');
  await sql.run(`INSERT INTO openai_replies (id, user_id, session_id, source, model, occurred_at) VALUES ('r1', 'u1', 'chatgpt:a', 'chatgpt_chat', 'gpt-6', ?)`, [NOW]);
  await sql.run(`INSERT INTO codex_turns (id, user_id, session_id, model, started_at) VALUES ('t1', 'u1', 'codex:b', 'gpt-6.1-sol', ?)`, [NOW]);
  await sql.run(`INSERT INTO openai_costs (id, user_id, hour_start, product, model, billed_in) VALUES ('oc1', 'u1', ?, 'chatgpt', 'gpt-6', 'usd')`, [NOW - (NOW % 3600)]);
});
afterAll(async () => cleanup());

describe('report figures by product', () => {
  it('counts prompts per product with the dashboard product rule', async () => {
    const { getProductFigures } = await import('@/lib/reports/product-figures');
    const figures = await getProductFigures(NOW - 86400, NOW + 1, NOW);
    const by = Object.fromEntries(figures.map(f => [f.id, f]));
    expect(by.claude_cowork).toMatchObject({ prompts: 1, flagged: 0 });
    expect(by.chatgpt_chat).toMatchObject({ prompts: 1, flagged: 1, label: 'ChatGPT Chat', vendor: 'openai' });
    expect(by.chatgpt_work).toMatchObject({ prompts: 1 });
    expect(by.claude_code).toMatchObject({ prompts: 1 });
    expect(by.codex).toMatchObject({ prompts: 1, last7: 0, prior7: 1, promptsInPeriod: 0 });
    expect(by.claude_chat).toBeUndefined();
  });

  it('names the product of an alert from its message id', async () => {
    const { productsForMessages } = await import('@/lib/reports/product-figures');
    const m = await productsForMessages(['g1', 'x1', 'c1']);
    expect(Object.fromEntries(m)).toEqual({ g1: 'ChatGPT Chat', x1: 'Codex', c1: 'Claude Cowork' });
  });

  it("the GDPR export carries the person's ChatGPT and Codex records", async () => {
    const { exportUserData } = await import('@/lib/db/queries');
    const data = await exportUserData('u1');
    expect(data?.openai.chatgpt_replies.map(r => r.id)).toEqual(['r1']);
    expect(data?.openai.codex_turns.map(r => r.id)).toEqual(['t1']);
    expect(data?.openai.hourly_costs.map(r => r.id)).toEqual(['oc1']);
  });
});
