// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Proof for error-tolerant transactions on Postgres.
//
// Postgres aborts the WHOLE transaction on any statement error. Two production
// transactions (OTel span ingest, GDPR user erasure) depend on continuing
// after a per-row error INSIDE one transaction. This file proves:
//   1. The hazard is real — a naive per-row try/catch inside ONE Postgres
//      transaction loses EVERY row once one row fails (batch poisoned).
//   2. lib/db/savepoint.ts `savepointEach` fixes it via a real SAVEPOINT per
//      row: the bad row is reported, the survivors COMMIT.
import { describe, it, expect } from 'vitest';
import { createTestDbClient } from './helpers/db';
import { savepointEach } from '@/lib/db/savepoint';
import { users as pgUsers } from '@/lib/db/schema.pg';

// A batch whose MIDDLE row duplicates the first row's primary key. The middle
// row must fail; the first and last must survive.
const BATCH = [
  { id: 'batch-1', display_name: 'first' },
  { id: 'batch-1', display_name: 'duplicate-pk — must fail' },
  { id: 'batch-2', display_name: 'last' },
];

describe('postgres abort semantics', () => {
  it(
    'HAZARD: a naive per-row try/catch inside one txn loses the whole batch',
    async () => {
      const { client, cleanup } = await createTestDbClient('postgres');
      // The union DrizzleClient type has two incompatible `.transaction`
      // signatures; a loose handle keeps the test readable.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = client as any;
      try {
        // No savepoints. On Postgres the first failure aborts the
        // transaction, so every subsequent statement errors and NOTHING
        // commits.
        await db.transaction(async (tx: typeof db) => {
          for (const row of BATCH) {
            try {
              await tx.insert(pgUsers).values(row);
            } catch {
              /* swallow, keep going — the habit that breaks on PG */
            }
          }
        });

        const rows = await db.select({ id: pgUsers.id }).from(pgUsers);
        expect(rows.length).toBe(0); // batch poisoned — survivors lost
      } finally {
        await cleanup();
      }
    },
    180_000,
  );

  it(
    'savepointEach: one bad row does NOT drop the rest of the batch',
    async () => {
      const { client, cleanup } = await createTestDbClient('postgres');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = client as any;
      try {
        const result = await db.transaction((tx: typeof db) =>
          savepointEach(tx, BATCH, async (sp, row) => {
            await sp.insert(pgUsers).values(row);
          }),
        );

        expect(result.ok).toBe(2);
        expect(result.errors.length).toBe(1);
        expect(result.errors[0].item.id).toBe('batch-1');

        const rows = await db.select({ id: pgUsers.id }).from(pgUsers);
        expect(rows.map((r: { id: string }) => r.id).sort()).toEqual([
          'batch-1',
          'batch-2',
        ]);
      } finally {
        await cleanup();
      }
    },
    180_000,
  );
});
