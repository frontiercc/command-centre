// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Automated runs: Claude Code sessions started by a script or test harness rather than typed by a
 * person. They are recognised by a measured rule, not by the AI classifier, and stored as their own
 * kind of work so they show as "Automated runs" wherever kinds of work are listed.
 *
 * The rule: a session with at most one prompt, where the same person started at least
 * AUTOMATED_MIN_SESSIONS such sessions within AUTOMATED_WINDOW_SECS. People typing start one to five
 * an hour; a harness starts dozens. Each run is still counted, priced and shown, it is only kept out
 * of the figures that describe how people hand work over (deep share, the groups behind So what and
 * Team coaching's people), where thousands of one-line runs would drown the people's own sessions.
 */
import { sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';

/** The stored kind of work for an automated run. Not offered to the classifier. */
export const AUTOMATED_WORK_TYPE = 'automated';
/** What the classifier_model column records for a row written by the rule. */
export const AUTOMATED_RULE_MODEL = 'rule:automated';
/** At least this many one-prompt sessions from one person inside the window. */
export const AUTOMATED_MIN_SESSIONS = 10;
/** The window, centred on each session. */
export const AUTOMATED_WINDOW_SECS = 3600;
/** How far back the rule looks each run. Sessions older than this keep what they have. */
export const AUTOMATED_LOOKBACK_SECS = 90 * 86400;

type Client = Awaited<ReturnType<typeof getTypedClient>>;

/**
 * Label every ended session that matches the rule as an automated run, whether it was waiting to be
 * classified or was already classified as something else. One statement, no model call. Returns the
 * number of sessions labelled.
 */
export async function markAutomatedRuns(client: Client, nowS: number, quietSecs: number): Promise<number> {
  const since = nowS - AUTOMATED_LOOKBACK_SECS;
  const cutoff = nowS - quietSecs;
  const half = Math.floor(AUTOMATED_WINDOW_SECS / 2);
  const result = await (client as unknown as { execute: (q: ReturnType<typeof sql>) => Promise<{ rowCount?: number | null }> }).execute(sql`
    WITH one_prompt AS (
      SELECT session_id, user_id, first_at, last_at,
             COUNT(*) OVER (
               PARTITION BY user_id ORDER BY first_at
               RANGE BETWEEN ${half} PRECEDING AND ${half} FOLLOWING
             ) AS nearby
      FROM code_session_stats
      WHERE user_msg_count <= 1 AND user_id IS NOT NULL AND first_at >= ${since - AUTOMATED_WINDOW_SECS}
    )
    INSERT INTO code_session_classifications
      (session_id, user_id, work_type, tier, confidence, classifier_model, status, error, classified_at, provisional)
    SELECT session_id, user_id, ${AUTOMATED_WORK_TYPE}, 1, 1, ${AUTOMATED_RULE_MODEL}, 'classified', NULL, ${nowS}, 0
    FROM one_prompt
    WHERE nearby >= ${AUTOMATED_MIN_SESSIONS} AND first_at >= ${since} AND last_at < ${cutoff}
    ON CONFLICT (session_id) DO UPDATE SET
      work_type = EXCLUDED.work_type, tier = EXCLUDED.tier, confidence = EXCLUDED.confidence,
      classifier_model = EXCLUDED.classifier_model, status = 'classified', error = NULL,
      classified_at = EXCLUDED.classified_at, provisional = 0
    WHERE code_session_classifications.work_type <> ${AUTOMATED_WORK_TYPE}
  `);
  return Number(result.rowCount ?? 0);
}

