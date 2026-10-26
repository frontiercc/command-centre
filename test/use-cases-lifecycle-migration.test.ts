// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;

let createUseCase: typeof import('@/lib/usecases/queries').createUseCase;
let getUseCase: typeof import('@/lib/usecases/queries').getUseCase;
let updateUseCase: typeof import('@/lib/usecases/queries').updateUseCase;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const queries = await import('@/lib/usecases/queries');
  createUseCase = queries.createUseCase;
  getUseCase = queries.getUseCase;
  updateUseCase = queries.updateUseCase;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec('DELETE FROM use_cases');
});

describe('migration 057 — lifecycle columns + tracking tables', () => {
  it('new use cases default to lifecycle not_seen', async () => {
    const uc = await createUseCase({ title: 'M057 default' });
    expect(uc.lifecycle).toBe('not_seen');
    expect(uc.lifecycleChangedAt).toBeNull();
  });

  it('lifecycle is patchable via updateUseCase', async () => {
    const uc = await createUseCase({ title: 'M057 patch' });
    const updated = await updateUseCase(uc.id, { lifecycle: 'piloting', lifecycleChangedAt: 1750000000 });
    expect(updated?.lifecycle).toBe('piloting');
    expect(updated?.lifecycleChangedAt).toBe(1750000000);
  });

  it('tracking tables exist with expected columns', async () => {
    const columnsOf = (table: string) =>
      sql.all<{ name: string }>(`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?`, [table]);
    const weekCols = await columnsOf('use_case_activation_weeks');
    expect(weekCols.map(c => c.name)).toEqual(
      expect.arrayContaining(['use_case_id', 'week_start', 'distinct_users', 'session_count', 'matched_messages', 'latest_tier', 'last_seen_at', 'updated_at'])
    );
    const matchCols = await columnsOf('use_case_week_matches');
    expect(matchCols.map(c => c.name)).toEqual(
      expect.arrayContaining(['use_case_id', 'week_start', 'user_id', 'session_id'])
    );
  });

  it('backfill maps legacy status values onto lifecycle', async () => {
    // Simulate what pre-057 rows looked like, then re-run the backfill statements
    // from the migration against them (the migration itself already ran in the harness).
    await sql.run(`INSERT INTO use_cases (id, title, status) VALUES ('m057-live', 'legacy live', 'live')`);
    await sql.run(`INSERT INTO use_cases (id, title, status) VALUES ('m057-ns', 'legacy not seen', 'not_seen')`);
    await sql.run(`UPDATE use_cases SET lifecycle = 'piloting', status = 'confirmed' WHERE status = 'live'`);
    await sql.run(`UPDATE use_cases SET lifecycle = 'not_seen', status = 'confirmed' WHERE status = 'not_seen'`);
    expect((await getUseCase('m057-live'))?.status).toBe('confirmed');
    expect((await getUseCase('m057-live'))?.lifecycle).toBe('piloting');
    expect((await getUseCase('m057-ns'))?.status).toBe('confirmed');
    expect((await getUseCase('m057-ns'))?.lifecycle).toBe('not_seen');
  });
});
