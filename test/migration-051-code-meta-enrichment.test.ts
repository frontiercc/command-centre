// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
});

afterAll(async () => cleanup());

describe('migration 051 — code_assistant_meta enrichment', () => {
  it('adds query_source, agent_name, skill_name, effort columns', async () => {
    const cols = (await sql.all<{ name: string }>(
      `SELECT column_name AS name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'code_assistant_meta'`,
    )).map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining(['query_source', 'agent_name', 'skill_name', 'effort']));
  });

  it('accepts an insert populating the new columns', async () => {
    await sql.run(
      `INSERT INTO code_assistant_meta
         (id, session_id, model, input_tokens, output_tokens, occurred_at,
          query_source, agent_name, skill_name, effort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['m1', 's1', 'claude-sonnet-4-6', 100, 50, 1750000000, 'subagent', 'code-reviewer', 'deep-research', 'high'],
    );
    const row = await sql.get<Record<string, string>>(`SELECT query_source, agent_name, skill_name, effort FROM code_assistant_meta WHERE id = 'm1'`);
    expect(row).toEqual({ query_source: 'subagent', agent_name: 'code-reviewer', skill_name: 'deep-research', effort: 'high' });
  });
});
