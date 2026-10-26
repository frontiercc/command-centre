// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
});

afterAll(async () => cleanup());

async function tableCols(name: string): Promise<string[]> {
  const rows = await sql.all<{ name: string }>(
    `SELECT column_name AS name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ?`,
    [name],
  );
  return rows.map(c => c.name);
}

// The chargeback tables are part of the Postgres baseline (0000).
describe('migration 060 — chargeback tables', () => {
  it('creates chargeback_cost_centres with id/code/name/created_at', async () => {
    expect((await tableCols('chargeback_cost_centres')).sort()).toEqual(['code', 'created_at', 'id', 'name']);
  });

  it('creates chargeback_dept_map with department/cost_centre_id', async () => {
    expect((await tableCols('chargeback_dept_map')).sort()).toEqual(['cost_centre_id', 'department']);
  });

  it('creates chargeback_periods with period/status/closed_at/closed_by/snapshot_json/estimated', async () => {
    expect((await tableCols('chargeback_periods')).sort()).toEqual(
      ['closed_at', 'closed_by', 'estimated', 'period', 'snapshot_json', 'status']
    );
  });
});
