// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest';

const confirmPiiMatch = vi.fn();
vi.mock('../lib/pii/confirm', async (orig) => ({
  ...(await orig<typeof import('../lib/pii/confirm')>()),
  confirmPiiMatch: (...a: unknown[]) => confirmPiiMatch(...a),
}));

const insertAlert = vi.fn();
vi.mock('../lib/db/queries', () => ({ insertAlert: (...a: unknown[]) => insertAlert(...a) }));

// Minimal Drizzle stand-in: the dedup query (selects `{ one }`) returns
// `selected.dedupRows` (default [], i.e. nothing recent), and the flag_reason
// read-modify-write (selects `{ flag_reason }`) returns `selected.rows`. A
// single fake that ignored which columns were requested would make seeding
// one also satisfy the other, tripping the dedup and skipping the
// alert/confirmation entirely — so this branches on the requested columns
// instead.
//
// The update's `.returning()` is queued via `updateReturns`: each call shifts
// the next queued result, defaulting to a matching row (a successful
// compare-and-swap) when the queue is empty, so tests that don't care about
// the CAS still see a normal single write.
//
// `rowsQueue` lets a test simulate another writer landing BETWEEN the CAS's
// two read attempts: when non-empty, each flag_reason select shifts the next
// queued result instead of returning the constant `selected.rows` — so the
// retry test below can prove the retry genuinely re-reads rather than
// re-using a stale value from the first read.
//
// `updateWhereArgs` captures the raw `where(...)` argument of every update
// call (previously discarded) so a test can inspect the actual predicate
// Drizzle built, rather than just how many times an update fired.
const updated: Array<Record<string, unknown>> = [];
const selected = { rows: [] as unknown[], dedupRows: [] as unknown[], rowsQueue: [] as unknown[][] };
const updateReturns: unknown[][] = [];
const updateWhereArgs: unknown[] = [];
let flagReasonSelectCount = 0;
vi.mock('../lib/db/client', () => ({
  getTypedClient: async () => ({
    select: (cols: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if ('flag_reason' in cols) {
              flagReasonSelectCount++;
              if (selected.rowsQueue.length > 0) return selected.rowsQueue.shift()!;
              return selected.rows;
            }
            return selected.dedupRows;
          },
        }),
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: (whereArg: unknown) => {
          updateWhereArgs.push(whereArg);
          return {
            returning: async () => {
              updated.push(v);
              return updateReturns.length > 0 ? updateReturns.shift()! : [{ id: 'm1' }];
            },
          };
        },
      }),
    }),
  }),
}));

// Drizzle's `and(a, b)` compiles to a `SQL` node whose `queryChunks` are
// exactly `["(", <SQL: a, " and ", b>, ")"]` — a single predicate (bare
// `eq(...)`, or `and()` called with only one argument) never gets that
// wrapping. Confirmed by inspecting a real `and(eq(...), eq(...))` at
// runtime: top-level length 3 with literal "(" / ")" StringChunks, and the
// middle chunk is itself an SQL node of length 3 (left, " and ", right) for
// exactly two predicates — a third predicate would make that inner length 5,
// a fourth 7, and so on. This is what lets the test below distinguish the
// production CAS predicate `and(eq(id), eq(flag_reason, existing))` (2
// conditions) from a hypothetical `eq(id)`-only where (1 condition, and the
// CAS protection gone) without depending on Drizzle's private internals
// beyond this shape.
function isTwoPredicateAnd(whereArg: unknown): boolean {
  const chunks = (whereArg as { queryChunks?: unknown[] } | undefined)?.queryChunks;
  if (!Array.isArray(chunks) || chunks.length !== 3) return false;
  const open = (chunks[0] as { value?: unknown[] } | undefined)?.value?.[0];
  const close = (chunks[2] as { value?: unknown[] } | undefined)?.value?.[0];
  const innerChunks = (chunks[1] as { queryChunks?: unknown[] } | undefined)?.queryChunks;
  return open === '(' && close === ')' && Array.isArray(innerChunks) && innerChunks.length === 3;
}

import { createPiiAlertsWithDedup } from '../lib/alerts/pii-alerts';


beforeEach(() => {
  confirmPiiMatch.mockReset();
  insertAlert.mockReset();
  updated.length = 0;
  selected.rows = [];
  selected.dedupRows = [];
  selected.rowsQueue = [];
  updateReturns.length = 0;
  updateWhereArgs.length = 0;
  flagReasonSelectCount = 0;
});

describe('createPiiAlertsWithDedup — confirmation', () => {
  it('does not call Claude for a self-proving type', async () => {
    await createPiiAlertsWithDedup('u1', [{ type: 'credit_card', masked: '****1111' }], 'txt', 'm1', 'cowork');
    expect(confirmPiiMatch).not.toHaveBeenCalled();
    expect(insertAlert).toHaveBeenCalledTimes(1);
  });

  it('calls Claude for a shape-only type and raises the alert on confirmed', async () => {
    confirmPiiMatch.mockResolvedValue({ verdict: 'confirmed', reason: null });
    await createPiiAlertsWithDedup('u1', [{ type: 'nino', masked: 'AB****56C' }], 'txt', 'm1', 'cowork');
    expect(confirmPiiMatch).toHaveBeenCalledTimes(1);
    expect(insertAlert).toHaveBeenCalledTimes(1);
  });

  it('raises NO alert on dismissed', async () => {
    confirmPiiMatch.mockResolvedValue({ verdict: 'dismissed', reason: 'a purchase order reference, not a NI number' });
    await createPiiAlertsWithDedup('u1', [{ type: 'nino', masked: 'AB****56C' }], 'txt', 'm1', 'cowork');
    expect(insertAlert).not.toHaveBeenCalled();
  });

  it('raises the alert when the check throws', async () => {
    confirmPiiMatch.mockRejectedValue(new Error('network'));
    await createPiiAlertsWithDedup('u1', [{ type: 'nino', masked: 'AB****56C' }], 'txt', 'm1', 'cowork');
    expect(insertAlert).toHaveBeenCalledTimes(1);
  });

  it('decides each type independently in a mixed message', async () => {
    confirmPiiMatch.mockImplementation(async (_t: string, type: string) =>
      type === 'nino' ? { verdict: 'dismissed', reason: 'an internal id' } : { verdict: 'confirmed', reason: null });
    await createPiiAlertsWithDedup('u1', [
      { type: 'nino', masked: 'AB****56C' },
      { type: 'iban', masked: 'GB82****32' },
    ], 'txt', 'm1', 'cowork');
    expect(insertAlert).toHaveBeenCalledTimes(1);
    expect(insertAlert.mock.calls[0][0].title).toContain('IBAN');
  });

  it('writes the verdicts onto flag_reason once', async () => {
    // Two shape-only types in the same call: a per-type write would also
    // produce exactly one update, so this needs both to prove the write is
    // a single batched annotation of the whole column, not a coincidence of
    // there being only one type to annotate.
    selected.rows = [{ flag_reason: 'PII detected: nino, iban' }];
    confirmPiiMatch.mockImplementation(async (_t: string, type: string) =>
      (type === 'nino' ? { verdict: 'dismissed', reason: 'an internal id' } : { verdict: 'confirmed', reason: null }));
    await createPiiAlertsWithDedup('u1', [
      { type: 'nino', masked: 'AB****56C' },
      { type: 'iban', masked: 'GB82****32' },
    ], 'txt', 'm1', 'cowork');
    expect(updated).toHaveLength(1);
    expect(updated[0].flag_reason).toBe('PII detected: nino (dismissed), iban (confirmed)');
  });

  it('writes a confirmed verdict onto flag_reason and still raises the alert', async () => {
    selected.rows = [{ flag_reason: 'PII detected: nino' }];
    confirmPiiMatch.mockResolvedValue({ verdict: 'confirmed', reason: null });
    await createPiiAlertsWithDedup('u1', [{ type: 'nino', masked: 'AB****56C' }], 'txt', 'm1', 'cowork');
    expect(insertAlert).toHaveBeenCalledTimes(1);
    expect(updated).toHaveLength(1);
    expect(updated[0].flag_reason).toBe('PII detected: nino (confirmed)');
  });

  it('spends no Claude call and writes nothing when the dedup check finds a recent alert', async () => {
    // The dedup select (no `flag_reason` in the requested columns) is seeded
    // here, not the flag_reason select — proving the confirmation genuinely
    // sits inside the `recentRows.length === 0` branch rather than merely
    // passing because the shared fake always returns `[]` for both selects.
    selected.dedupRows = [{ one: 1 }];
    await createPiiAlertsWithDedup('u1', [{ type: 'nino', masked: 'AB****56C' }], 'txt', 'm1', 'cowork');
    expect(confirmPiiMatch).not.toHaveBeenCalled();
    expect(insertAlert).not.toHaveBeenCalled();
    expect(updated).toHaveLength(0);
  });

  it('retries the flag_reason write once on a compare-and-swap conflict, then gives up', async () => {
    // First attempt's .returning() comes back empty — as if intent-alerts.ts
    // wrote flag_reason between our read and our write — the second succeeds.
    // The seeded read is a QUEUE, not a constant: the first read sees the
    // column as it was before the race, the second sees what the other
    // writer (intent-alerts.ts) appended in between — proving the retry
    // genuinely re-reads and recomputes rather than re-writing a stale
    // value it cached from the first attempt.
    selected.rowsQueue = [
      [{ flag_reason: 'PII detected: nino' }],
      [{ flag_reason: 'PII detected: nino | Intent detected: data_exfiltration (high)' }],
    ];
    confirmPiiMatch.mockResolvedValue({ verdict: 'dismissed', reason: 'a purchase order reference, not a NI number' });
    updateReturns.push([], [{ id: 'm1' }]);
    await createPiiAlertsWithDedup('u1', [{ type: 'nino', masked: 'AB****56C' }], 'txt', 'm1', 'cowork');
    expect(flagReasonSelectCount).toBe(2); // re-read before the retry
    expect(updated).toHaveLength(2); // wrote again, not just re-read
    expect(updated[0].flag_reason).toBe('PII detected: nino (dismissed)');
    // Carries BOTH the recomputed verdict AND the intent segment that landed
    // between the two reads — a cached-first-read implementation would have
    // written 'PII detected: nino (dismissed)' again here, losing the
    // intent-alerts.ts segment entirely.
    expect(updated[1].flag_reason).toBe('PII detected: nino (dismissed) | Intent detected: data_exfiltration (high)');

    // Both write attempts use a compare-and-swap WHERE — two predicates
    // (id AND flag_reason pinned to what was just read), never just the id.
    // This is what actually stops a concurrent writer's text being lost;
    // deleting `eq(table.flag_reason, existing)` from the production code
    // collapses this to a single-predicate where and fails these two lines
    // while every other assertion in this file stays green.
    expect(updateWhereArgs).toHaveLength(2);
    expect(isTwoPredicateAnd(updateWhereArgs[0])).toBe(true);
    expect(isTwoPredicateAnd(updateWhereArgs[1])).toBe(true);
  });

  it('gives up silently after a second compare-and-swap conflict rather than looping', async () => {
    selected.rows = [{ flag_reason: 'PII detected: nino' }];
    confirmPiiMatch.mockResolvedValue({ verdict: 'confirmed', reason: null }); // alert fires regardless of the annotation race below
    updateReturns.push([], []); // both attempts lose the race
    await expect(
      createPiiAlertsWithDedup('u1', [{ type: 'nino', masked: 'AB****56C' }], 'txt', 'm1', 'cowork'),
    ).resolves.toBeUndefined();
    expect(flagReasonSelectCount).toBe(2);
    expect(updated).toHaveLength(2); // exactly two attempts — no unbounded loop
    expect(insertAlert).toHaveBeenCalledTimes(1); // the alert itself is untouched by the annotation failure
  });

  it('never writes flagged', async () => {
    selected.rows = [{ flag_reason: 'PII detected: nino' }];
    confirmPiiMatch.mockResolvedValue({ verdict: 'dismissed', reason: 'a purchase order reference, not a NI number' });
    await createPiiAlertsWithDedup('u1', [{ type: 'nino', masked: 'AB****56C' }], 'txt', 'm1', 'cowork');
    expect(updated[0]).not.toHaveProperty('flagged');
  });
});
