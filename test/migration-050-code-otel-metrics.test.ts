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

async function columnNames(table: string): Promise<string[]> {
  const rows = await sql.all<{ name: string }>(
    `SELECT column_name AS name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ?`,
    [table],
  );
  return rows.map(c => c.name);
}

describe('migration 050 — code_otel_metrics', () => {
  it('creates the code_otel_metrics table with the expected columns', async () => {
    const cols = await columnNames('code_otel_metrics');
    expect(cols).toEqual(
      expect.arrayContaining([
        'id', 'user_id', 'session_id', 'metric_name', 'value',
        'type', 'model', 'language', 'occurred_at', 'ingested_at',
      ]),
    );
  });

  it('accepts an insert into code_otel_metrics', async () => {
    await sql.run(
      `INSERT INTO code_otel_metrics (id, user_id, session_id, metric_name, value, type, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['dp1', 'usr1', 'sess1', 'claude_code.active_time.total', 42.5, 'user', 1750000000],
    );
    const row = await sql.get<{ value: number; type: string }>(`SELECT value, type FROM code_otel_metrics WHERE id = 'dp1'`);
    expect(row!.value).toBe(42.5);
    expect(row!.type).toBe('user');
  });

  it('extends code_metrics with the Phase 1 aggregate columns', async () => {
    const cols = await columnNames('code_metrics');
    expect(cols).toEqual(
      expect.arrayContaining([
        'active_time_user_s', 'active_time_cli_s', 'lines_added',
        'lines_removed', 'pr_count', 'edit_accept_count', 'edit_reject_count',
      ]),
    );
  });
});
