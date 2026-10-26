// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// SAVEPOINT-isolated, error-tolerant per-row execution.
//
// Postgres aborts the ENTIRE transaction the instant any statement errors:
// every subsequent statement fails with "current transaction is aborted,
// commands ignored until end of transaction block". Transactions that catch
// per-row errors and carry on, such as GDPR user-erasure (lib/db/queries.ts,
// ~10 tolerated DELETEs), would otherwise lose every row after the first failure
// (a partial erasure is a compliance hazard).
//
// The fix is a SAVEPOINT per item: a nested `tx.transaction(async (sp) => …)`
// issues a real SAVEPOINT on node-postgres; a throw inside rolls back to it,
// leaving the outer transaction and every prior row intact, and the loop
// continues (verified in test/tx-savepoint-semantics.test.ts).

/** One row's failure: the offending item plus whatever the driver threw. */
export interface SavepointFailure<T> {
  item: T;
  error: unknown;
}

export interface SavepointResult<T> {
  /** Count of items whose `fn` completed and committed. */
  ok: number;
  /** Items whose `fn` threw; the surrounding batch was NOT aborted. */
  errors: Array<SavepointFailure<T>>;
}

/**
 * Minimal shape we actually invoke on the Postgres path: a handle that can
 * open a nested transaction (a SAVEPOINT). Used only for an internal cast —
 * `savepointEach`'s public generic `H` stays unconstrained so a caller can
 * pass whatever concrete drizzle transaction/database handle they hold
 * (`PgTransaction` or a top-level database).
 */
interface NestableTx {
  transaction: <R>(fn: (savepoint: unknown) => Promise<R>) => Promise<R>;
}

/**
 * Run `fn` for each item with per-item error isolation (a real SAVEPOINT per
 * item), so one failing row does NOT drop the survivors.
 *
 * Call it INSIDE the caller's existing transaction, passing that transaction
 * as `tx`:
 *
 *   const { ok, errors } = await (await getClient()).transaction(async (tx) =>
 *     savepointEach(tx, spans, async (sp, span) => {
 *       await sp.insert(otelEvents).values(mapSpan(span)).onConflictDoNothing();
 *     }),
 *   );
 *
 * Each item runs in `tx.transaction(async (sp) => fn(sp, item))` (a
 * SAVEPOINT); a rejection rolls back to that savepoint and the loop continues.
 * The returned `{ ok, errors }` reports exactly which rows survived and which
 * failed, and the helper never throws for a per-item failure.
 *
 * @param tx    the caller's active transaction (or database) handle.
 * @param items the rows to process, in order.
 * @param fn    per-item work; receives the per-item savepoint handle (`sp`)
 *              to write through.
 */
export async function savepointEach<H, T>(
  tx: H,
  items: Iterable<T>,
  fn: (handle: H, item: T) => Promise<void> | void,
): Promise<SavepointResult<T>> {
  const errors: Array<SavepointFailure<T>> = [];
  let ok = 0;

  for (const item of items) {
    try {
      // Real SAVEPOINT: nested transaction on node-postgres. A throw inside
      // triggers ROLLBACK TO SAVEPOINT, leaving the outer txn + prior rows
      // intact; we then record the failure and continue. `sp` is a fresh
      // handle of the same concrete type as `tx` (a PgTransaction), so the
      // cast back to `H` is sound.
      await (tx as unknown as NestableTx).transaction(async (sp) => {
        await fn(sp as H, item);
      });
      ok++;
    } catch (error) {
      errors.push({ item, error });
    }
  }

  return { ok, errors };
}
