// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Proves Postgres `citext` on `admin_users.email` gives
// case-insensitive EQUALITY *and* a case-insensitive UNIQUE constraint.
//
// Scope note (verified, not assumed — see the comment above `adminUsers` in
// lib/db/schema.pg.ts): `admin_users.email` is the ONLY email column with
// case-insensitive semantics. `users.email` is plain `text` — case-SENSITIVE —
// and is deliberately NOT covered by this test; giving it citext would
// introduce a divergence, not fix one.
//
// The spec uses the raw pg.Pool ($client) directly rather than the query
// builder, since the point under test is a DB-level constraint/collation, not
// app query logic. createTestDbClient('postgres') already ran the full
// lib/db/migrations-pg set (CREATE EXTENSION citext + admin_users.email
// citext) via startPg(), so no per-test DDL is needed.
import { describe, it, expect } from 'vitest';

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (client as any).$client;

    await raw.query(
      `INSERT INTO admin_users (id, email, password_hash) VALUES ($1, $2, $3)`,
      ['a1', 'A@x.com', 'hash1']
    );

    // Case-differing INSERT violates the citext-backed unique constraint.
    await expect(
      raw.query(`INSERT INTO admin_users (id, email, password_hash) VALUES ($1, $2, $3)`, [
        'a2',
        'a@x.com',
        'hash2',
      ])
    ).rejects.toThrow(/duplicate key value violates unique constraint/);

    // Case-differing `=` lookup still finds the row — citext governs
    // equality, not just the unique index.
    const { rows } = await raw.query(`SELECT id, email FROM admin_users WHERE email = $1`, [
      'A@X.COM',
    ]);
    expect(rows[0]?.id).toBe('a1');
    expect(rows[0]?.email).toBe('A@x.com'); // stored value is untouched
  } finally {
    await cleanup();
  }
}

describe('admin_users.email case-insensitive uniqueness + equality', () => {
  it(
    'citext rejects a case-differing duplicate and matches a case-differing lookup',
    async () => {
      await runSpec();
    },
    180_000,
  );
});
