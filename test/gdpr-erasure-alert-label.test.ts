// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Drift lock for the GDPR erasure alert's human-readable label.
//
// deleteUserData() resolves display_name/email BEFORE the delete wipes them, so
// the "User data erased (GDPR)" alert names the person rather than printing a
// bare UUID (same class of fix as the Alerts-page and High-Friction-Sessions
// display-name work). Nothing else asserts this text: the erasure coverage
// drift-lock is a COLUMN-level model and explicitly cannot see inside
// alerts.explanation. Without this test the label can be reverted silently —
// which nearly happened, since the change ran uncommitted in the deployed
// image for nine days while main still had the bare-UUID version.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';
import { deleteUserData } from '@/lib/db/queries';

let sql: TestSql;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
});

afterAll(async () => cleanup?.());

beforeEach(async () => {
  await sql.run(`DELETE FROM alerts`);
  await sql.run(`DELETE FROM users`);
});

async function seedUser(id: string, email: string, displayName: string | null) {
  const now = Math.floor(Date.now() / 1000);
  await sql.run(
    `INSERT INTO users (id, email, display_name, source, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, 'otel', ?, ?)`,
    [id, email, displayName, now, now],
  );
}

async function erasureAlertText(): Promise<string> {
  const row = await sql.get<{ explanation: string }>(
    `SELECT explanation FROM alerts WHERE title = 'User data erased (GDPR)' LIMIT 1`,
  );
  return row?.explanation ?? '';
}

describe('GDPR erasure alert names the person, not just a UUID', () => {
  it('uses display_name when present, and still records the id for traceability', async () => {
    await seedUser('user-uuid-1', 'ada@test.local', 'Ada Lovelace');

    await deleteUserData('user-uuid-1');

    const text = await erasureAlertText();
    expect(text).toContain('Ada Lovelace');
    // The id is deliberately retained alongside the name as erasure evidence
    // (Art. 17(3) basis, see docs/SECURITY.md) — the label supplements it,
    // it does not replace it.
    expect(text).toContain('user-uuid-1');
    // Guards the exact regression: a bare id with no human label.
    expect(text).not.toMatch(/All data for user-uuid-1 permanently/);
  });

  it('falls back to email when the user has no display_name', async () => {
    await seedUser('user-uuid-2', 'grace@test.local', null);

    await deleteUserData('user-uuid-2');

    expect(await erasureAlertText()).toContain('grace@test.local');
  });
});
