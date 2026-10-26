// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Shared drain helper for the two scheduled AI classifiers (Cowork's
// runClassifierJob, Code's runCodeClassifierJob) and their two admin
// "run now" buttons. Both jobs used to process exactly one batch per
// scheduled run — a cap sized for a customer with under 100 people. This
// lets a run keep pulling batches until the backlog empties, nothing
// progresses, a pass cap is hit, or a time budget is spent — one piece of
// logic instead of four different hand-rolled termination loops.
//
// Deliberately imports NOTHING from lib/ingestion/scheduler.ts, which
// imports ~25 job modules that touch the database at load time
// (test/scheduler-restart-generation.test.ts:10-13). Both admin routes
// import this file directly today without pulling in the scheduler — if
// drain.ts imported it, they would transitively load every job module just
// to run one classifier drain.
import { getConfigValue } from '@/lib/config';

export interface DrainPassResult {
  /** Rows/sessions this pass selected as candidates, before classifying them. */
  selected: number;
  classified: number;
  failed: number;
  /**
   * Set when this pass's model call itself failed (rejected key, outage) —
   * as opposed to a parse failure or attempt-exhausted rows. The scheduler
   * records it as a job failure; without it a
   * rejected key read as a successful run.
   */
  apiError?: string;
}

export interface DrainOptions {
  /** Hard ceiling on passes this call will run. */
  maxPasses: number;
  /**
   * Wall-clock budget in ms. Checked before a pass STARTS, never mid-pass —
   * so the worst case is budgetMs plus one more pass. Omit for no budget
   * (used by the admin "run now" routes, where a human is waiting and the
   * scheduler cycle is not at risk).
   */
  budgetMs?: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
  /**
   * Re-checked before every pass, including the first. Returning false
   * stops the drain immediately, before that pass's runOnce() is called.
   * The scheduler passes a closure over its generation counter here, so a
   * demoted leader stops draining rather than running up to maxPasses more
   * passes beside the newly-elected leader against the same queue head.
   */
  shouldContinue?: () => boolean;
}

export interface DrainResult {
  /** Number of passes actually run. */
  passes: number;
  classified: number;
  failed: number;
  /** The last pass's apiError, if any pass's model call failed. */
  apiError?: string;
}

/**
 * Run `runOnce` repeatedly until the queue is empty (selected === 0),
 * nothing progressed (classified === 0 — covers an API outage, a
 * whole-batch parse failure, and a batch of attempt-exhausted rows), the
 * pass cap is reached, or the time budget is spent.
 *
 * There is deliberately no failure budget and no early-stop-on-short-batch
 * — both were tried in earlier revisions of this design and neither could
 * be justified without measurement. A head batch that fails in full returns
 * classified=0 and stops the drain at pass 1; on a surface with retries
 * this resolves itself once that batch's attempts exhaust.
 */
export async function drainJob(
  runOnce: () => Promise<DrainPassResult>,
  opts: DrainOptions,
): Promise<DrainResult> {
  const now = opts.now ?? Date.now;
  const start = now();

  let passes = 0;
  let classified = 0;
  let failed = 0;
  let apiError: string | undefined;

  for (let i = 0; i < opts.maxPasses; i++) {
    if (opts.shouldContinue && !opts.shouldContinue()) break;
    if (opts.budgetMs !== undefined && now() - start >= opts.budgetMs) break;

    const result = await runOnce();
    passes++;
    classified += result.classified;
    failed += result.failed;
    if (result.apiError) apiError = result.apiError;

    if (result.selected === 0) break;
    if (result.classified === 0) break;
  }

  return apiError ? { passes, classified, failed, apiError } : { passes, classified, failed };
}

/**
 * How many passes a SCHEDULED drain may run. Never read by the admin "run
 * now" routes, which pass an explicit maxPasses instead (today: 20,
 * preserving their existing button behaviour).
 *
 * getConfigValue returns '' for an unset key (lib/config.ts:530 — it never
 * falls back to getAllConfig's default). parseInt('', 10) is NaN, and a
 * loop bounded by `i < NaN` runs ZERO passes on every comparison — both
 * classifiers would silently stop on every instance that has never set this
 * key, with no symptom but a growing queue. The `|| '5'` and the
 * Number.isFinite check below are each independently sufficient to prevent
 * that; both are kept as belt-and-braces, because three prior revisions of
 * this design got exactly this arithmetic wrong.
 */
export async function resolveClassifierDrainMaxPasses(): Promise<number> {
  const raw = await getConfigValue('classifierDrainMaxPasses');
  const n = parseInt(raw || '5', 10);
  return Number.isFinite(n) && n >= 1 ? n : 5;
}
