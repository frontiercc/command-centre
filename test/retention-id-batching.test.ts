// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Retention used to hand every expired cowork_messages id to ONE inArray()
// delete. In strip mode those rows are never deleted, so the list grows with
// all history; past 65,535 ids Postgres refuses the statement and the whole
// cleanup fails every night (a production deployment reached 63,028). The ids
// are now deleted in batches of RETENTION_ID_BATCH. This seeds more than two
// batches and checks children in the first and last batch are both removed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
let mod: typeof import('@/lib/retention/cleanup');

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  mod = await import('@/lib/retention/cleanup');
});

afterAll(async () => { await cleanup(); });

describe('chunkIds', () => {
  it('splits into batches of the given size and returns nothing for an empty list', () => {
    expect(mod.chunkIds([], 3)).toEqual([]);
    expect(mod.chunkIds([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
    expect(mod.RETENTION_ID_BATCH).toBeLessThan(32_766); // well under the bound-parameter limit
  });
});

describe('runRetentionCleanup — expired id lists larger than one batch', () => {
  it('removes pulse children across every batch in strip mode', async () => {
    const total = mod.RETENTION_ID_BATCH * 2 + 500;
    const old = Math.floor(Date.now() / 1000) - 40 * 86400;

    await sql.exec(`INSERT INTO config (key, value) VALUES ('retention_mode', 'strip')
               ON CONFLICT(key) DO UPDATE SET value = excluded.value;
             INSERT INTO config (key, value) VALUES ('retention_cowork_days', '30')
               ON CONFLICT(key) DO UPDATE SET value = excluded.value;`);
    await sql.run(`INSERT INTO users (id, email, display_name, source, first_seen_at, last_seen_at)
                VALUES ('rb-u', 'rb@test.local', 'RB', 'otel', ?, ?)`, [old, old]);

    // Multi-row inserts of 500 (1,000 bound values, well under Postgres's
    // parameter limit) rather than one round trip per row.
    const CHUNK = 500;
    for (let start = 0; start < total; start += CHUNK) {
      const n = Math.min(CHUNK, total - start);
      const values = Array.from({ length: n }, () => `(?, 'rb-u', 'rb-s', 'cowork', 'cowork_user_message', 'old prompt', ?)`).join(', ');
      const params = Array.from({ length: n }, (_, j) => [`rb-m-${start + j}`, old]).flat();
      await sql.run(`INSERT INTO cowork_messages (id, user_id, session_id, surface, message_type, content_preview, occurred_at)
                     VALUES ${values}`, params);
    }

    const firstId = 'rb-m-0';
    const lastId = `rb-m-${total - 1}`;
    const insertCls = `INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at)
                       VALUES (?, 'rb-u', 2, 'analysis', 0.9, 'haiku', ?)`;
    await sql.run(insertCls, [firstId, old]);
    await sql.run(insertCls, [lastId, old]);

    await mod.runRetentionCleanup();

    const remaining = (await sql.get(`SELECT COUNT(*) AS n FROM pulse_classifications WHERE cowork_message_id IN (?, ?)`, [firstId, lastId])) as { n: number };
    expect(remaining.n).toBe(0);

    // Strip mode keeps the parent rows, so the id list keeps growing run to run.
    const msgs = (await sql.get(`SELECT COUNT(*) AS n FROM cowork_messages WHERE user_id = 'rb-u'`)) as { n: number };
    expect(msgs.n).toBe(total);
  }, 60_000);
});
