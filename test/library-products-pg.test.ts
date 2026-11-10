// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// S&C Board entries name the products they are used in, from their uses:
// Claude, ChatGPT (Chat and Work) and Codex.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
let entryProducts: typeof import('@/lib/library/products').entryProducts;

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
  ({ entryProducts } = await import('@/lib/library/products'));
  await sql.run(`INSERT INTO users (id, email) VALUES ('u1', 'u1@test.local')`);
  const skill = (id: string, name: string, source: string) => sql.run(
    `INSERT INTO cowork_skill_invocations (id, user_id, session_id, skill_name, occurred_at, source) VALUES (?, 'u1', 's', ?, 1, ?)`, [id, name, source]);
  const conn = (id: string, name: string, source: string, surface: string) => sql.run(
    `INSERT INTO cowork_mcp_invocations (id, user_id, session_id, mcp_server, mcp_tool, occurred_at, source, surface) VALUES (?, 'u1', ?, ?, 't', 1, ?, ?)`, [id, `s-${id}`, name, source, surface]);
  await skill('a', 'pdfs', 'chatgpt_chat');
  await skill('b', 'pdfs', 'chatgpt_work');
  await skill('c', 'board-pack', 'otel');
  await skill('d', 'board-pack', 'chatgpt_work');
  await conn('e', 'linear', 'codex', 'code');
  await conn('f', 'linear', 'otel', 'cowork');
});
afterAll(async () => cleanup());

describe('entryProducts', () => {
  it('names each entry by the products it is used in, Claude first', async () => {
    const m = await entryProducts([
      { name: 'pdfs', type: 'skill' }, { name: 'board-pack', type: 'skill' },
      { name: 'linear', type: 'connector' }, { name: 'unused', type: 'skill' },
    ]);
    expect(m.get('pdfs')).toEqual(['ChatGPT']);
    expect(m.get('board-pack')).toEqual(['Claude', 'ChatGPT']);
    expect(m.get('linear')).toEqual(['Claude', 'Codex']);
    expect(m.has('unused')).toBe(false);
  });
});
