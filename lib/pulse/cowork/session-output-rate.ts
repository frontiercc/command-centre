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
 *
 * Claude Chat conversations count too, from what their replies made
 * (chat_assistant_meta: an artifact or a generated file is something produced).
 * A conversation with no reply on record is not measured and is left out, the
 * same as an unaggregated Cowork session. A conversation starts at its first prompt.
 */

import { sql, type SQL } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { weekStarts } from '@/lib/pulse/period';
import { sessionKindSql, MECHANISM_TASK_TYPES } from '@/lib/finance/model-efficiency';
import { outputRate } from './session-output';
import type { Vendor } from '@/lib/dashboard/vendor';

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
  /** Never null here — a row only appears once it clears MIN_SESSIONS_FOR_RATE. */
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

/** One week and kind of work, counted by the database. Counts come back as strings. */
interface GroupedRow {
  wk: number | string;
  /** Null when the session carries no classification. */
  task_type: string | null;
  sessions: number | string;
  produced: number | string;
}

/**
 * Build the report over the last `OUTPUT_RATE_WEEKS` completed Monday-UTC weeks.
 *
 * `nowS` is injectable so tests pin the window rather than racing the clock.
 */
export async function buildSessionOutputRate(nowS: number = Math.floor(Date.now() / 1000), vendor: Vendor = 'all'): Promise<SessionOutputRateReport> {
  // weekStarts(ts, n) yields n Monday-UTC starts ending with the week containing
  // ts; anchoring a week back gives the last COMPLETED weeks, never the partial
  // current one (same call shape as buildGovernanceRollup).
  const windowWeeks = weekStarts(nowS - WEEK_SECS, OUTPUT_RATE_WEEKS);
  const windowStart = windowWeeks[0];
  const windowEnd = windowWeeks[windowWeeks.length - 1] + WEEK_SECS;

  const client = await getTypedClient();
  const exec = client as unknown as { execute: (q: SQL) => Promise<{ rows: unknown[] }> };
  const withClaude = vendor !== 'openai';

  // Every measured session that started in the window, on each platform the view covers: its id,
  // when it started, and 1 or 0 for whether it produced something. Unmeasured ones are left out.
  const parts: SQL[] = [];
  if (withClaude) {
    // Claude Cowork and Claude in Office/Google, from the session aggregator.
    parts.push(sql`
      SELECT css.session_id, css.first_event_at, css.produced_output AS produced
      FROM cowork_session_stats css
      WHERE css.first_event_at IS NOT NULL AND css.produced_output IS NOT NULL
        AND css.first_event_at >= ${windowStart} AND css.first_event_at < ${windowEnd}`);
    // Claude Chat: one row per conversation started in the window, produced from its replies.
    // A conversation with no reply on record is not measured.
    parts.push(sql`
      SELECT c.session_id, c.first_at AS first_event_at, c.produced FROM (
        SELECT x.session_id, x.first_at,
               (SELECT CASE WHEN COUNT(*) = 0 THEN NULL
                            WHEN SUM(m.artifacts_count + m.generated_files_count) > 0 THEN 1 ELSE 0 END
                FROM chat_assistant_meta m WHERE m.conversation_id = x.session_id) AS produced
        FROM (
          SELECT cm.session_id, MIN(cm.occurred_at) AS first_at
          FROM cowork_messages cm
          WHERE cm.surface = 'chat' AND cm.message_type = 'cowork_user_message' AND cm.session_id IS NOT NULL
            -- Only conversations with a prompt in the window, so the grouping reads those, not every
            -- conversation ever held. One whose first prompt is in the window always has one there.
            AND cm.session_id IN (
              SELECT w.session_id FROM cowork_messages w
              WHERE w.surface = 'chat' AND w.message_type = 'cowork_user_message'
                AND w.occurred_at >= ${windowStart} AND w.occurred_at < ${windowEnd}
            )
          GROUP BY cm.session_id
          HAVING MIN(cm.occurred_at) >= ${windowStart} AND MIN(cm.occurred_at) < ${windowEnd}
        ) x
      ) c WHERE c.produced IS NOT NULL`);
  }
  if (vendor !== 'claude') {
    // ChatGPT: one row per conversation started in the window; a reply OpenAI lists files on made
    // something. Replies stored before the count was kept are not measured.
    parts.push(sql`
      SELECT g.session_id, g.first_at AS first_event_at, g.produced FROM (
        SELECT g0.session_id, g0.first_at,
               (SELECT CASE WHEN COUNT(r.files_count) = 0 THEN NULL
                            WHEN SUM(r.files_count) > 0 THEN 1 ELSE 0 END
                FROM openai_replies r WHERE r.session_id = g0.session_id) AS produced
        FROM chatgpt_session_time g0
        WHERE g0.first_at >= ${windowStart} AND g0.first_at < ${windowEnd}
      ) g WHERE g.produced IS NOT NULL`);
  }

  // The database counts the sessions by the week they started and by their kind of work (the
  // shared rule in lib/finance/model-efficiency.ts, sessionKindSql), and sends back one row per
  // week and kind instead of every session and every label. Sessions are bucketed by
  // first_event_at, so one straddling a Monday counts once, in the week it began.
  const grouped = parts.length === 0 ? [] : (await exec.execute(sql`
    WITH s AS (${sql.join(parts, sql` UNION ALL `)}),
    k AS (${sessionKindSql(sql`SELECT session_id FROM s`)})
    SELECT FLOOR((s.first_event_at - ${windowStart}) / ${WEEK_SECS}) AS wk,
           k.task_type,
           COUNT(*) AS sessions,
           SUM(CASE WHEN s.produced = 1 THEN 1 ELSE 0 END) AS produced
    FROM s LEFT JOIN k ON k.session_id = s.session_id
    GROUP BY 1, 2
  `)).rows as GroupedRow[];

  // Seed every window week so an empty week renders as a measured gap rather
  // than vanishing from the series.
  const byWeek = new Map<number, { sessions: number; produced: number }>();
  for (const w of windowWeeks) byWeek.set(w, { sessions: 0, produced: 0 });

  let sessions = 0;
  let produced = 0;
  const byTaskTypeAcc = new Map<string, { sessions: number; produced: number }>();

  for (const row of grouped) {
    // Number() throughout: Postgres hands counts and sums back as strings.
    const bucket = byWeek.get(windowWeeks[Number(row.wk)]);
    if (!bucket) continue; // defensive: a row outside the window the WHERE already excluded
    const n = Number(row.sessions);
    const p = Number(row.produced);
    bucket.sessions += n;
    bucket.produced += p;
    sessions += n;
    produced += p;

    // Named kinds of work only, see the note on the breakdown above. A session
    // we cannot name still counts toward the headline and the weekly trend; it
    // simply gets no row of its own.
    if (row.task_type !== null && !MECHANISM_TASK_TYPES.has(row.task_type)) {
      const tt = byTaskTypeAcc.get(row.task_type) ?? { sessions: 0, produced: 0 };
      tt.sessions += n;
      tt.produced += p;
      byTaskTypeAcc.set(row.task_type, tt);
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
