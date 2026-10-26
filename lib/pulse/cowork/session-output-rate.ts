// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Session output rate — the DB read layer.
 *
 * The pure predicate lives in ./session-output.ts; this module only fetches the
 * sessions and buckets them. See that file for what counts as output and why.
 *
 * Window is 13 COMPLETED Monday-UTC weeks, the same convention as the
 * governance rollup (lib/usecases/governance.ts) and the Delegation View, so a
 * reader comparing two cards on /pulse/cio is comparing the same period.
 *
 * Sessions are bucketed by `first_event_at` — when the work STARTED. A session
 * straddling a Monday boundary belongs to the week it began, so it is counted
 * exactly once and never double-counted across weeks (the same attribute-to-
 * earliest rule impact-rollup.ts applies).
 *
 * Reads `produced_output` (migration 079 / PG 0020), which the session
 * aggregator writes from the tool name AND `tool_success` together. A session
 * whose `produced_output` is still NULL has not been aggregated since the
 * column was added and is EXCLUDED from both numerator and denominator —
 * counting it as "produced nothing" would silently depress the rate with
 * unmeasured sessions.
 *
 * Null-not-zero throughout: a week with no measured sessions returns
 * `rate: null`, never 0 — "we measured nothing" and "nothing was produced"
 * are different claims.
 */

import { and, gte, isNotNull, lt } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { weekStarts } from '@/lib/pulse/period';
import { buildSessionTaskTypeMap, MECHANISM_TASK_TYPES } from '@/lib/finance/model-efficiency';
import { outputRate } from './session-output';

const WEEK_SECS = 7 * 24 * 60 * 60;

/** How many completed weeks the series covers. Matches the governance rollup. */
export const OUTPUT_RATE_WEEKS = 13;

/**
 * How many sessions a slice needs before its RATE is reported.
 *
 * One session that produced something is not "100%", it is one session, and a
 * rate drawn from it invites a conclusion the data cannot support. Applies to
 * BOTH cuts:
 *   - a task type below the floor is dropped from the breakdown entirely;
 *   - a WEEK below the floor keeps its counts but reports `rate: null`, so the
 *     trend renders a gap rather than a spike.
 * In one case a single-session week read 100% and drew a
 * full-height bar towering over the meaningful 34-46% weeks beside it.
 *
 * Thin slices still count toward the headline, which is where they belong.
 */
export const MIN_SESSIONS_FOR_RATE = 5;

/** @deprecated Use MIN_SESSIONS_FOR_RATE — kept so no caller breaks silently. */
export const MIN_SESSIONS_FOR_TASK_TYPE = MIN_SESSIONS_FOR_RATE;

/**
 * The breakdown lists NAMED KINDS OF WORK only.
 *
 * Two sorts of session get no row. They still count in the headline and the
 * weekly trend — they are simply not something a reader can act on:
 *
 *   - sessions the classifier never labelled;
 *   - sessions carrying ONLY mechanism labels (connector_assisted and friends).
 *     The collapse falls back to one when a session has nothing else, which is
 *     right for FinOps — spend has to sit somewhere — but wrong here.
 *     "Connector assisted" is not a kind of work, it is how the session ran,
 *     and listing it invites a circular reading: a session defined by
 *     orchestrating connectors was always going to write a file.
 *
 * There is deliberately no "Unclassified" row either. It answers nothing, and
 * on real data it would usually top the list by volume and bury the work types
 * the card exists to compare.
 */

export interface OutputRateWeek {
  /** Monday 00:00 UTC, epoch seconds. */
  weekStart: number;
  /** Sessions that started in this week. */
  sessions: number;
  /** Of those, how many produced something. */
  produced: number;
  /**
   * produced / sessions, or null when the week has no sessions OR too few to
   * support a rate (see MIN_SESSIONS_FOR_RATE). The counts stay either way —
   * only the rate is withheld.
   */
  rate: number | null;
}

export interface OutputRateByTaskType {
  taskType: string;
  sessions: number;
  produced: number;
  /** Never null here — a row only appears once it clears MIN_SESSIONS_FOR_TASK_TYPE. */
  rate: number;
}

export interface SessionOutputRateReport {
  /** True once any session exists in the window — the card hides entirely otherwise. */
  hasData: boolean;
  /** Headline over the whole window. */
  sessions: number;
  produced: number;
  rate: number | null;
  /** Oldest first. A week with no sessions is present with rate null, never dropped. */
  weeks: OutputRateWeek[];
  /**
   * Which kinds of work actually produce something. Rate DESCENDING, so the
   * weakest converters sort to the bottom where the gap is. Empty when no task
   * type clears the floor — the headline still stands on its own.
   */
  byTaskType: OutputRateByTaskType[];
}

interface StatsRow {
  session_id: string;
  first_event_at: number | string | null;
  /** 1 produced, 0 did not, NULL not yet aggregated (excluded entirely). */
  produced_output: number | string | null;
}

/**
 * Build the report over the last `OUTPUT_RATE_WEEKS` completed Monday-UTC weeks.
 *
 * `nowS` is injectable so tests pin the window rather than racing the clock.
 */
export async function buildSessionOutputRate(nowS: number = Math.floor(Date.now() / 1000)): Promise<SessionOutputRateReport> {
  // weekStarts(ts, n) yields n Monday-UTC starts ending with the week containing
  // ts; anchoring a week back gives the last COMPLETED weeks, never the partial
  // current one (same call shape as buildGovernanceRollup).
  const windowWeeks = weekStarts(nowS - WEEK_SECS, OUTPUT_RATE_WEEKS);
  const windowStart = windowWeeks[0];
  const windowEnd = windowWeeks[windowWeeks.length - 1] + WEEK_SECS;

  const client = await getTypedClient();
  const css = schema.coworkSessionStats;

  const rows = (await client
    .select({ session_id: css.session_id, first_event_at: css.first_event_at, produced_output: css.produced_output })
    .from(css)
    .where(and(
      isNotNull(css.first_event_at),
      isNotNull(css.produced_output),
      gte(css.first_event_at, windowStart),
      lt(css.first_event_at, windowEnd),
    ))) as StatsRow[];

  // Seed every window week so an empty week renders as a measured gap rather
  // than vanishing from the series.
  const byWeek = new Map<number, { sessions: number; produced: number }>();
  for (const w of windowWeeks) byWeek.set(w, { sessions: 0, produced: 0 });

  let sessions = 0;
  let produced = 0;
  // Collapse each session's classifications to one task_type using the shared
  // rule in lib/finance/model-efficiency.ts (most-frequent, newest breaks a
  // tie). Session-based, NOT a message-id join — pulse_classifications tags
  // cowork_user_message rows while the session's other evidence sits on
  // different rows in the same session.
  const taskTypeBySession = await buildSessionTaskTypeMap(client, rows.map((r) => r.session_id));
  const byTaskTypeAcc = new Map<string, { sessions: number; produced: number }>();

  for (const row of rows) {
    const startedAt = Number(row.first_event_at);
    if (!Number.isFinite(startedAt)) continue;

    // Integer-divide into the seeded bucket rather than recomputing weekStart per
    // row — the window is contiguous, so the offset is exact.
    const idx = Math.floor((startedAt - windowStart) / WEEK_SECS);
    const bucket = byWeek.get(windowWeeks[idx]);
    if (!bucket) continue; // defensive: a row outside the window the WHERE already excluded

    // Number() not truthiness — Postgres can hand an integer column back as a string.
    const didProduce = Number(row.produced_output) === 1;
    bucket.sessions += 1;
    sessions += 1;
    if (didProduce) {
      bucket.produced += 1;
      produced += 1;
    }

    // Named kinds of work only — see the note on the breakdown above. A session
    // we cannot name still counts toward the headline and the weekly trend; it
    // simply gets no row of its own.
    const taskType = taskTypeBySession.get(row.session_id);
    if (taskType !== undefined && !MECHANISM_TASK_TYPES.has(taskType)) {
      const tt = byTaskTypeAcc.get(taskType) ?? { sessions: 0, produced: 0 };
      tt.sessions += 1;
      if (didProduce) tt.produced += 1;
      byTaskTypeAcc.set(taskType, tt);
    }
  }

  const weeks: OutputRateWeek[] = windowWeeks.map((weekStart) => {
    const b = byWeek.get(weekStart)!;
    const rate = b.sessions >= MIN_SESSIONS_FOR_RATE ? outputRate(b.produced, b.sessions) : null;
    return { weekStart, sessions: b.sessions, produced: b.produced, rate };
  });

  const byTaskType: OutputRateByTaskType[] = [...byTaskTypeAcc.entries()]
    .filter(([, v]) => v.sessions >= MIN_SESSIONS_FOR_RATE)
    .map(([taskType, v]) => ({ taskType, sessions: v.sessions, produced: v.produced, rate: v.produced / v.sessions }))
    .sort((a, b) => b.rate - a.rate || b.sessions - a.sessions);

  return { hasData: sessions > 0, sessions, produced, rate: outputRate(produced, sessions), weeks, byTaskType };
}
