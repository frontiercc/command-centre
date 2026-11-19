// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Migration 0058: cowork_messages gains client_version, os_type and os_version.
// A hub that already has these columns (added by its own build before this
// release) must keep them and the values in them, so every statement is
// ADD COLUMN IF NOT EXISTS. This replays the migration over a migrated database.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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

describe('migration 0058: client version and operating system on Cowork prompts', () => {
  it('runs again over existing columns without touching their values', async () => {
    await sql.run(`INSERT INTO cowork_messages (id, session_id, message_type, surface, source, occurred_at, client_version, os_type, os_version)
      VALUES ('m1', 's1', 'cowork_user_message', 'cowork', 'otel', 100, '1.5354.0', 'win32', '10.0.26200')`);

    const file = path.join(process.cwd(), 'lib/db/migrations-pg/0058_cowork_client_info.sql');
    for (const statement of readFileSync(file, 'utf8').split('--> statement-breakpoint')) {
      await sql.exec(statement);
    }

    const row = (await sql.get(`SELECT client_version, os_type, os_version FROM cowork_messages WHERE id = 'm1'`)) as Record<string, string | null>;
    expect(row).toEqual({ client_version: '1.5354.0', os_type: 'win32', os_version: '10.0.26200' });
  });
});
