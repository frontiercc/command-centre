// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Recent activity for a use case (the detail page's live box and the
 * API-only force-check route), plus the department resolver other modules
 * share. Since use cases are defined by the work, activity is
 * read from judged sessions; it used to be a one-shot OR-match of keywords,
 * skills, connectors and task labels over raw telemetry.
 */
import { sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { weekStart } from '@/lib/pulse/period';
import type { UseCase } from '@/lib/usecases/queries';

export interface ActivateEvidence {
  seen: boolean;
  distinctUsers: number;
  sessionCount: number;
  matchedMessages: number;
  latestTier: number | null;
  lastSeenAt: number | null;
  windowDays: number;
  signals: string[];
}

/**
 * The use case's recent activity, read from its judged sessions:
 * the sessions the session judge matched to it, or that ran its
 * own codified skill, whose last activity falls in the last `windowDays`. The
 * same records the weekly figures are counted from, so the box and the weekly
 * table always agree. Read-only; never throws for a use case with no clues
 * (clues only help the judge; they are not needed to measure).
 * `signals`: 'work' when any session was judged by its work, 'skill' when
 * any ran the use case's own skill.
 */
export async function activateUseCase(uc: UseCase, nowEpochS?: number, windowDays: number = 30): Promise<ActivateEvidence> {
  const nowS = nowEpochS ?? Math.floor(Date.now() / 1000);
  const windowStart = nowS - windowDays * 86400;
  // Counted from the weekly match records (the same ones the weekly table
  // reads, in weeks overlapping the window), so the box and the table agree
  // and activity recorded without a judgement (older weeks, seeded demo data)
  // still shows. A judgement, where there is one, adds the session's prompt
  // count, its last activity and how it matched, and drops a session whose
  // last activity is before the window.
  const firstWeek = weekStart(windowStart);
  const client = await getTypedClient();
  const res = await client.execute(sql`
    WITH s AS (
      SELECT DISTINCT m.session_id, m.user_id, m.week_start, j.prompt_count, j.last_event_at,
             (j.use_case_ids::jsonb ? ${uc.id}) AS by_work,
             (j.skill_matched_ids::jsonb ? ${uc.id}) AS by_skill
        FROM use_case_week_matches m
        LEFT JOIN use_case_session_judgements j ON j.session_id = m.session_id AND m.session_id <> ''
       WHERE m.use_case_id = ${uc.id} AND m.week_start >= ${firstWeek}
         AND (j.session_id IS NULL OR j.last_event_at >= ${windowStart})
    )
    SELECT
      (SELECT COUNT(DISTINCT user_id) FROM s) AS users,
      (SELECT COUNT(DISTINCT session_id) FROM s WHERE session_id <> '') AS sessions,
      (SELECT COALESCE(SUM(prompt_count), 0) FROM s) AS messages,
      GREATEST(
        (SELECT MAX(last_event_at) FROM s),
        (SELECT MAX(w.last_seen_at) FROM use_case_activation_weeks w WHERE w.use_case_id = ${uc.id} AND w.week_start >= ${firstWeek})
      ) AS last_seen,
      (SELECT bool_or(by_work) FROM s) AS by_work,
      (SELECT bool_or(by_skill) FROM s) AS by_skill,
      GREATEST(
        (SELECT MAX(pc.tier) FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
          WHERE cm.session_id IN (SELECT session_id FROM s) AND pc.classifier_status = 'classified'),
        (SELECT MAX(csc.tier) FROM code_session_classifications csc WHERE csc.session_id IN (SELECT session_id FROM s))
      ) AS tier`);
  const r = (res as unknown as { rows: Array<Record<string, unknown>> }).rows[0] ?? {};
  const sessionCount = Number(r.sessions ?? 0);
  const distinctUsers = Number(r.users ?? 0);
  const signals: string[] = [];
  if (r.by_work === true) signals.push('work');
  if (r.by_skill === true) signals.push('skill');
  return {
    seen: distinctUsers > 0,
    distinctUsers,
    sessionCount,
    matchedMessages: Number(r.messages ?? 0),
    latestTier: r.tier == null ? null : Number(r.tier),
    lastSeenAt: r.last_seen == null ? null : Number(r.last_seen),
    windowDays,
    signals,
  };
}
