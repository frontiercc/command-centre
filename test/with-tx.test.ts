// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Fix I3 — direct contract tests for lib/db/with-tx.ts `withTx` on Postgres.
//
// Three contracts:
//   (a) ROLLBACK — a callback that throws persists ZERO rows.
//   (b) CONCURRENCY (the C1 regression guard) — two OVERLAPPING withTx calls on
//       the same client both complete atomically.
//   (c) RE-ENTRANCY (M4) — nested withTx throws a clear, actionable error
//       instead of a cryptic driver message / a deadlock.
//
// Harness rule (same as error-queries.test.ts): the module-under-test binds its
// database on first use, so dynamic-import AFTER createTestDbClient() has set
// DATABASE_URL + reset modules.
import { describe, it, expect } from 'vitest';
const yieldTick = () => new Promise<void>((r) => setImmediate(r));

/**
 * Run the full withTx spec. Everything is dynamic-imported after DATABASE_URL
 * is set (harness rule).
 */
async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = client as any;
    // The table object + the helper, imported AFTER DATABASE_URL is set.
    const { withTx } = await import('@/lib/db/with-tx');
    const t = (await import('@/lib/db/schema.pg')).pgSchema.errorEvents;

    const nowS = Math.floor(Date.now() / 1000);
    const row = (message: string) => ({
      occurred_at: nowS,
      severity: 'error',
      source: 'test',
      message,
    });
    const countRows = async (): Promise<number> =>
      (await db.select().from(t)).length;

    // ── (a) ROLLBACK: a throwing callback persists nothing ────────────────
    await expect(
      withTx(client, async (tx) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (tx as any).insert(t).values(row('rolled-back-1'));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (tx as any).insert(t).values(row('rolled-back-2'));
        throw new Error('boom — abort this transaction');
      }),
    ).rejects.toThrow('boom');
    expect(await countRows()).toBe(0);

    // ── (b) CONCURRENCY: two OVERLAPPING withTx calls both commit atomically
    // Each transaction inserts two rows with a yield BETWEEN them, so the two
    // would interleave if they shared one connection unserialized. Launched
    // together (no await between) so they genuinely overlap.
    const txnA = withTx(client, async (tx) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tx as any).insert(t).values(row('A-1'));
      await yieldTick();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tx as any).insert(t).values(row('A-2'));
      return 'A';
    });
    const txnB = withTx(client, async (tx) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tx as any).insert(t).values(row('B-1'));
      await yieldTick();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (tx as any).insert(t).values(row('B-2'));
      return 'B';
    });

    const results = await Promise.all([txnA, txnB]);
    expect(results.sort()).toEqual(['A', 'B']);

    // Both transactions committed fully and atomically → all four rows present,
    // none dropped, none partially committed.
    const messages = (await db.select().from(t))
      .map((r: { message: string }) => r.message)
      .filter((m: string) => m.startsWith('A-') || m.startsWith('B-'))
      .sort();
    expect(messages).toEqual(['A-1', 'A-2', 'B-1', 'B-2']);

    // ── (c) RE-ENTRANCY: nested withTx throws a clear, actionable error ───
    await expect(
      withTx(client, async () => {
        // Nested call on the SAME handle — must be rejected up-front.
        await withTx(client, async () => undefined);
      }),
    ).rejects.toThrow(/cannot be nested/i);
  } finally {
    await cleanup();
  }
}

describe('withTx', () => {
  it(
    'rollback + concurrency + re-entrancy contracts hold on postgres',
    async () => {
      await runSpec();
    },
    180_000,
  );
});
