// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The background indexes (lib/db/background-indexes.ts) are built without blocking writes, once,
// and an invalid one left by a failed build is dropped and built again.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;

const state = () => sql.all<{ name: string; valid: boolean }>(
  `SELECT c.relname AS name, i.indisvalid AS valid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
    WHERE c.relname LIKE 'idx_cowork_messages_session_%' ORDER BY 1`);

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
});

afterAll(async () => cleanup());

describe('background indexes', () => {
  it('builds each missing index, valid, and does nothing the second time', async () => {
    const { ensureBackgroundIndexes, BACKGROUND_INDEXES } = await import('@/lib/db/background-indexes');
    expect(await ensureBackgroundIndexes()).toEqual(BACKGROUND_INDEXES.map(i => i.name));
    expect(await state()).toEqual(BACKGROUND_INDEXES.map(i => ({ name: i.name, valid: true })).sort((a, b) => a.name.localeCompare(b.name)));
    expect(await ensureBackgroundIndexes()).toEqual([]);
  });

  it('rebuilds an index a failed build left invalid', async () => {
    const { ensureBackgroundIndexes } = await import('@/lib/db/background-indexes');
    await sql.run(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'idx_cowork_messages_session_output'::regclass`);
    expect(await ensureBackgroundIndexes()).toEqual(['idx_cowork_messages_session_output']);
    expect((await state()).every(r => r.valid)).toBe(true);
  });
});
