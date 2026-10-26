// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Transaction wrapper: runs one async callback inside a real Postgres
// transaction (`client.transaction(async tx => …)`) — atomic, rolled back on
// throw. Postgres aborts the WHOLE transaction on any statement error, so for
// error-TOLERANT per-row batches use `savepointEach` (lib/db/savepoint.ts)
// INSIDE the callback instead of a bare loop. The pg pool gives each
// transaction its own connection, so concurrent `withTx` calls are isolated.
//
// SCOPE / CAVEATS
//   • Top-level only. Do NOT nest `withTx` inside `withTx` — the re-entrancy
//     guard below throws a clear error (Postgres would otherwise silently open
//     a second, independent pooled transaction). For per-row error isolation
//     inside a transaction use `savepointEach`.
//   • The callback receives the handle to write through; pass it to your
//     Drizzle query builders and `await` them.
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Set of handles whose `withTx` is open in the CURRENT async context. Backed by
 * AsyncLocalStorage (not a plain WeakSet) so it distinguishes true RE-ENTRANCY
 * (a nested `withTx` on the same handle, which inherits the parent context and
 * so sees the handle) from legitimate CONCURRENCY (two independent top-level
 * `withTx` calls on the same handle run in SEPARATE contexts and must NOT trip
 * the guard — the pg pool gives each its own connection). Keying on the handle also lets nested `withTx` on a
 * DIFFERENT handle (e.g. main client inside an audit-client txn) pass, since
 * those are independent connections.
 */
const openTxHandles = new AsyncLocalStorage<Set<object>>();

/**
 * Run `fn` inside a single transaction, returning whatever `fn` returns.
 *
 *   const count = await withTx(await getClient(), async (tx) => {
 *     await tx.insert(schema.errorEvents).values(rows);
 *     return rows.length;
 *   });
 *
 * @param client a Drizzle client/handle from getClient().
 * @param fn     the transactional work; receives the handle to write through.
 */
export async function withTx<H, T>(
  client: H,
  fn: (tx: H) => Promise<T>,
): Promise<T> {
  const handleKey = client as unknown as object;

  // Re-entrancy guard (M4). A nested `withTx` on the SAME handle inherits this
  // async context and so finds the handle already open → throw a clear,
  // actionable error. Two INDEPENDENT top-level calls run in separate contexts
  // and pass (concurrency is legitimate — the pg pool isolates them). Without
  // this, Postgres would silently open a second, independent pooled
  // transaction. Genuine nested/tolerant work belongs in savepointEach, which
  // opens a real SAVEPOINT inside the current transaction.
  const parent = openTxHandles.getStore();
  if (parent?.has(handleKey)) {
    throw new Error(
      'withTx cannot be nested: a transaction is already open on this handle. ' +
        'Use savepointEach (lib/db/savepoint.ts) for per-row work inside a transaction.',
    );
  }
  const store = new Set(parent);
  store.add(handleKey);

  return openTxHandles.run(store, async () => {
    // `tx` is a PgTransaction — a fresh handle of the same concrete shape as
    // `client`, so the cast back to `H` is sound (mirrors lib/db/savepoint.ts).
    return (
      client as unknown as {
        transaction: (cb: (tx: H) => Promise<T>) => Promise<T>;
      }
    ).transaction((tx) => fn(tx));
  });
}
