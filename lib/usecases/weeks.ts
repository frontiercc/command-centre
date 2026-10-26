// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Weekly rollup + exact-distinct junction for use-case tracking (migration 057).
 * A rollup row per tracked use case is written EVERY tracker run — including
 * zero-activity weeks — so an absent row provably means "not measuring".
 *
 * Composite-PK upserts use Drizzle's onConflictDoNothing({ target: [...] })
 * (see lib/pulse/aggregator.ts's writeMetric for the array-target precedent).
 * The last_seen_at bump uses GREATEST (Postgres has no scalar multi-arg MAX —
 * MAX/MIN are aggregates). The latest_tier "keep the higher value, or leave
 * unchanged if this batch carried no tier" logic is a CASE expression, simply
 * omitted from the update when this batch's tier is null (equivalent to
 * "leave unchanged").
 */
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { weekStart } from '@/lib/pulse/period';

export interface WeekActivity {
  weekStart: number;
  distinctUsers: number;
  sessionCount: number;
  matchedMessages: number;
  latestTier: number | null;
  lastSeenAt: number | null;
}

export async function ensureWeekRow(useCaseId: string, weekStartS: number): Promise<void> {
  const client = await getTypedClient();
  const t = schema.useCaseActivationWeeks;
  const nowS = Math.floor(Date.now() / 1000);
  await client
    .insert(t)
    .values({ use_case_id: useCaseId, week_start: weekStartS, updated_at: nowS })
    .onConflictDoNothing({ target: [t.use_case_id, t.week_start] });
}

export async function recordWeekMatches(
  useCaseId: string,
  weekStartS: number,
  matches: Array<{ userId: string | null; sessionId: string | null; occurredAt: number; isMessage: boolean; tier?: number | null }>,
): Promise<void> {
  if (matches.length === 0) return;
  const client = await getTypedClient();
  await ensureWeekRow(useCaseId, weekStartS);

  const t = schema.useCaseWeekMatches;
  let messageCount = 0;
  let latestTier: number | null = null;
  let lastSeen = 0;

  for (const m of matches) {
    if (m.userId != null) {
      await client
        .insert(t)
        .values({ use_case_id: useCaseId, week_start: weekStartS, user_id: m.userId, session_id: m.sessionId ?? '' })
        .onConflictDoNothing({ target: [t.use_case_id, t.week_start, t.user_id, t.session_id] });
    }
    if (m.isMessage) messageCount++;
    if (m.tier != null && (latestTier === null || m.tier > latestTier)) latestTier = m.tier;
    if (m.occurredAt > lastSeen) lastSeen = m.occurredAt;
  }

  const countsRows = await client
    .select({
      users: sql<number>`COUNT(DISTINCT ${t.user_id})`,
      sessions: sql<number>`COUNT(DISTINCT CASE WHEN ${t.session_id} != '' THEN ${t.session_id} END)`,
    })
    .from(t)
    .where(and(eq(t.use_case_id, useCaseId), eq(t.week_start, weekStartS)));
  const counts = { users: Number(countsRows[0]?.users ?? 0), sessions: Number(countsRows[0]?.sessions ?? 0) };

  const wt = schema.useCaseActivationWeeks;
  const nowS = Math.floor(Date.now() / 1000);
  const greatest = (a: ReturnType<typeof sql>, b: number) => sql`GREATEST(${a}, ${b})`;

  const set: Record<string, unknown> = {
    distinct_users: counts.users,
    session_count: counts.sessions,
    matched_messages: sql`${wt.matched_messages} + ${messageCount}`,
    last_seen_at: greatest(sql`COALESCE(${wt.last_seen_at}, 0)`, lastSeen),
    updated_at: nowS,
  };
  // Only touch latest_tier when this batch actually carried a tier — otherwise
  // leave the column unchanged (equivalent to the original COALESCE fallback).
  if (latestTier !== null) {
    set.latest_tier = sql`CASE WHEN ${wt.latest_tier} IS NULL OR ${wt.latest_tier} < ${latestTier} THEN ${latestTier} ELSE ${wt.latest_tier} END`;
  }

  await client.update(wt).set(set as never).where(and(eq(wt.use_case_id, useCaseId), eq(wt.week_start, weekStartS)));
}

function rowToWeek(r: { week_start: number; distinct_users: number; session_count: number; matched_messages: number; latest_tier: number | null; last_seen_at: number | null }): WeekActivity {
  return {
    weekStart: r.week_start,
    distinctUsers: r.distinct_users,
    sessionCount: r.session_count,
    matchedMessages: r.matched_messages,
    latestTier: r.latest_tier,
    lastSeenAt: r.last_seen_at,
  };
}

/** Last n measured completed weeks, ascending. Excludes the current week; absent weeks simply aren't returned. */
export async function getMeasuredCompletedWeeks(useCaseId: string, n: number, nowS: number): Promise<WeekActivity[]> {
  const client = await getTypedClient();
  const t = schema.useCaseActivationWeeks;
  const currentWeek = weekStart(nowS);
  const rows = await client
    .select({
      week_start: t.week_start, distinct_users: t.distinct_users, session_count: t.session_count,
      matched_messages: t.matched_messages, latest_tier: t.latest_tier, last_seen_at: t.last_seen_at,
    })
    .from(t)
    .where(and(eq(t.use_case_id, useCaseId), lt(t.week_start, currentWeek)))
    .orderBy(desc(t.week_start))
    .limit(n);
  return rows.map(rowToWeek).reverse();
}

export async function getCurrentWeek(useCaseId: string, nowS: number): Promise<WeekActivity | null> {
  const client = await getTypedClient();
  const t = schema.useCaseActivationWeeks;
  const rows = await client
    .select({
      week_start: t.week_start, distinct_users: t.distinct_users, session_count: t.session_count,
      matched_messages: t.matched_messages, latest_tier: t.latest_tier, last_seen_at: t.last_seen_at,
    })
    .from(t)
    .where(and(eq(t.use_case_id, useCaseId), eq(t.week_start, weekStart(nowS))))
    .limit(1);
  return rows[0] ? rowToWeek(rows[0]) : null;
}

export async function getWindowDistinctUsers(useCaseId: string, weekStartsS: number[]): Promise<number> {
  if (weekStartsS.length === 0) return 0;
  const client = await getTypedClient();
  const t = schema.useCaseWeekMatches;
  const rows = await client
    .select({ n: sql<number>`COUNT(DISTINCT ${t.user_id})` })
    .from(t)
    .where(and(eq(t.use_case_id, useCaseId), inArray(t.week_start, weekStartsS)));
  return Number(rows[0]?.n ?? 0);
}

// ─── Judged sessions (use cases defined by the work) ──
//
// A session judged to be an instance of a use case is ONE junction row in the
// week of its first event. A session can be judged again (new activity, or the
// department's use cases changed) and its answer can change, so a week's
// figures are recounted from what is recorded rather than incremented.

/** Records a judged session against a use case in one week (idempotent). */
export async function addSessionMatch(useCaseId: string, weekStartS: number, userId: string, sessionId: string): Promise<void> {
  const client = await getTypedClient();
  await ensureWeekRow(useCaseId, weekStartS);
  const t = schema.useCaseWeekMatches;
  await client
    .insert(t)
    .values({ use_case_id: useCaseId, week_start: weekStartS, user_id: userId, session_id: sessionId })
    .onConflictDoNothing({ target: [t.use_case_id, t.week_start, t.user_id, t.session_id] });
}

/** Removes a session from a use case in every week; returns the weeks it was in, so they can be recounted. */
export async function removeSessionMatches(useCaseId: string, sessionId: string): Promise<number[]> {
  const client = await getTypedClient();
  const t = schema.useCaseWeekMatches;
  const rows = await client
    .delete(t)
    .where(and(eq(t.use_case_id, useCaseId), eq(t.session_id, sessionId)))
    .returning({ week_start: t.week_start });
  return [...new Set(rows.map(r => Number(r.week_start)))];
}

/**
 * Recounts a week from its junction rows: distinct people and sessions; the
 * prompts in those sessions (from their judgements) as matched messages; the
 * latest event; the deepest tier seen (Cowork classifications, Code session
 * tiers). Null-safe: a week with no sessions reads zero, not missing.
 */
export async function refreshWeekFromJunction(useCaseId: string, weekStartS: number): Promise<void> {
  const client = await getTypedClient();
  await ensureWeekRow(useCaseId, weekStartS);
  const rows = await client.execute(sql`
    WITH s AS (
      SELECT DISTINCT user_id, session_id FROM use_case_week_matches
       WHERE use_case_id = ${useCaseId} AND week_start = ${weekStartS}
    )
    SELECT
      (SELECT COUNT(DISTINCT user_id) FROM s) AS users,
      (SELECT COUNT(DISTINCT session_id) FROM s WHERE session_id <> '') AS sessions,
      (SELECT COALESCE(SUM(j.prompt_count), 0) FROM use_case_session_judgements j WHERE j.session_id IN (SELECT session_id FROM s)) AS messages,
      (SELECT MAX(j.last_event_at) FROM use_case_session_judgements j WHERE j.session_id IN (SELECT session_id FROM s)) AS last_seen,
      GREATEST(
        (SELECT MAX(pc.tier) FROM pulse_classifications pc JOIN cowork_messages cm ON cm.id = pc.cowork_message_id
          WHERE cm.session_id IN (SELECT session_id FROM s) AND pc.classifier_status = 'classified'),
        (SELECT MAX(csc.tier) FROM code_session_classifications csc WHERE csc.session_id IN (SELECT session_id FROM s))
      ) AS tier`);
  const r = (rows as unknown as { rows: Array<Record<string, unknown>> }).rows[0] ?? {};
  const wt = schema.useCaseActivationWeeks;
  await client.update(wt).set({
    distinct_users: Number(r.users ?? 0),
    session_count: Number(r.sessions ?? 0),
    matched_messages: Number(r.messages ?? 0),
    last_seen_at: r.last_seen == null ? null : Number(r.last_seen),
    latest_tier: r.tier == null ? null : Number(r.tier),
    updated_at: Math.floor(Date.now() / 1000),
  }).where(and(eq(wt.use_case_id, useCaseId), eq(wt.week_start, weekStartS)));
}
