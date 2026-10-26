// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// OTI v2. OTI is a per-person
// TRAJECTORY signal — how much deeper a user's delegation has become relative
// to their own start — NOT a cross-person, governance-grade measure.
//
// v2 changes vs v1:
//   - Baseline = the user's FIRST 30 classified events (frozen once 30 accrue);
//     until then it is computed against the events available so far and flagged
//     `earlyRead`. The tile is never empty.
//   - Both windows are rate-normalised by ACTIVE DAYS and summarised by the
//     MEDIAN of each active day's weighted output, not the mean/sum,
//     so a single burst day of low-value prompts cannot inflate the number.
//   - Current window with < 2 active days does not publish a fresh value; it
//     signals `stale` so the caller can hold the last stored value.
//
// Async Drizzle on Postgres. count/bigint→Number
// (Policy B) at every aggregate read.
import { and, eq, inArray } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * OTI v2 result. `value` is the trajectory ratio (current ÷ baseline median
 * daily weighted output), or null when it cannot be published yet:
 *   - the user has no classified events at all → computeUserOti returns null;
 *   - the current 7-day window has < 2 active days → `value: null, stale: true`
 *     (caller holds the previously stored value and marks it stale);
 *   - the baseline median is 0 (not constructible under tier CHECK ≥ 1).
 */
export interface OtiResult {
  value: number | null;
  /** True until the user's 30th classified event lands (baseline still forming). */
  earlyRead: boolean;
  /** True once the first-30-event baseline has frozen. */
  baselineFrozen: boolean;
  activeDaysBaseline: number;
  activeDaysCurrent: number;
  /** True when the current window has < 2 active days, so no fresh value is published. */
  stale: boolean;
}

interface ClassifiedEvent {
  occurredAt: number;
  tier: number;
}

const DAY = 24 * 60 * 60; // seconds
const SEVEN_DAYS = 7 * DAY;
const BASELINE_EVENT_COUNT = 30;

// ─── Pure helpers ──────────────────────────────────────────────────────────────

/** Median of a numeric list (average of the two middle values for even length). */
function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Group events into UTC-day buckets and return each active day's WEIGHTED output
 * (sum of tier weights that day: T1=1, T2=2, T3=3). One entry per active day.
 */
function dailyWeightedOutputs(events: ClassifiedEvent[]): number[] {
  const byDay = new Map<number, number>();
  for (const e of events) {
    const day = Math.floor(e.occurredAt / DAY);
    byDay.set(day, (byDay.get(day) ?? 0) + e.tier);
  }
  return [...byDay.values()];
}

/**
 * Pure OTI v2 computation from a user's full classified-event history.
 * `events` need not be pre-sorted. `nowS` is the current unix time (seconds).
 * Returns null only when the user has no classified events.
 */
export function computeOtiFromEvents(events: ClassifiedEvent[], nowS: number): OtiResult | null {
  if (events.length === 0) return null;

  const ordered = [...events].sort((a, b) => a.occurredAt - b.occurredAt);

  // Baseline: the user's first 30 classified events, frozen once 30 accrue.
  // (We take exactly the first 30 events; a day straddling the 30-boundary
  // contributes only the events within the first 30.)
  const baselineFrozen = ordered.length >= BASELINE_EVENT_COUNT;
  const baselineEvents = baselineFrozen ? ordered.slice(0, BASELINE_EVENT_COUNT) : ordered;
  const baselineDaily = dailyWeightedOutputs(baselineEvents);
  const baselineMedian = median(baselineDaily);

  // Current window: rolling 7 days ending now.
  const windowStart = nowS - SEVEN_DAYS;
  const currentEvents = ordered.filter(e => e.occurredAt >= windowStart && e.occurredAt <= nowS);
  const currentDaily = dailyWeightedOutputs(currentEvents);

  const activeDaysBaseline = baselineDaily.length;
  const activeDaysCurrent = currentDaily.length;
  const earlyRead = !baselineFrozen;

  // < 2 active days in the current window → do not publish a fresh value.
  if (activeDaysCurrent < 2) {
    return { value: null, earlyRead, baselineFrozen, activeDaysBaseline, activeDaysCurrent, stale: true };
  }

  const value = baselineMedian > 0 ? median(currentDaily) / baselineMedian : null;
  return { value, earlyRead, baselineFrozen, activeDaysBaseline, activeDaysCurrent, stale: false };
}

// ─── DB access ───────────────────────────────────────────────────────────────

/** Fetch all classified events (occurred_at + tier) for a set of users, grouped by user. */
async function getClassifiedEventsForUsers(userIds: string[]): Promise<Map<string, ClassifiedEvent[]>> {
  const result = new Map<string, ClassifiedEvent[]>();
  if (userIds.length === 0) return result;

  const db = await getTypedClient();
  const pc = schema.pulseClassifications;
  const cm = schema.coworkMessages;

  const rows = await db
    .select({ user_id: pc.user_id, occurred_at: cm.occurred_at, tier: pc.tier })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .where(and(inArray(pc.user_id, userIds), eq(pc.classifier_status, 'classified')));

  for (const row of rows) {
    const list = result.get(row.user_id) ?? [];
    list.push({ occurredAt: Number(row.occurred_at), tier: Number(row.tier) });
    result.set(row.user_id, list);
  }
  return result;
}

// ─── Per-user OTI ─────────────────────────────────────────────────────────────

/**
 * Compute OTI v2 for a single user. Returns null when the user has no
 * classified events at all; otherwise an OtiResult (whose `value` may itself be
 * null for the stale/degenerate cases described on OtiResult).
 */
export async function computeUserOti(userId: string): Promise<OtiResult | null> {
  const byUser = await getClassifiedEventsForUsers([userId]);
  const events = byUser.get(userId) ?? [];
  return computeOtiFromEvents(events, Math.floor(Date.now() / 1000));
}

// ─── Batch OTI ────────────────────────────────────────────────────────────────

/**
 * Compute OTI v2 for a set of users in a single history query. Semantics are
 * identical to calling computeUserOti(id) for each id: users with no classified
 * events map to null. Users not present in the input map to null too.
 */
export async function computeOtiForUsers(userIds: string[]): Promise<Map<string, OtiResult | null>> {
  const result = new Map<string, OtiResult | null>();
  if (userIds.length === 0) return result;

  for (const id of userIds) result.set(id, null);

  const nowS = Math.floor(Date.now() / 1000);
  const byUser = await getClassifiedEventsForUsers(userIds);
  for (const id of userIds) {
    const events = byUser.get(id);
    result.set(id, events && events.length > 0 ? computeOtiFromEvents(events, nowS) : null);
  }
  return result;
}

// ─── Per-team / per-dept OTI ────────────────────────────────────────────────────

/** Average the publishable OTI `value`s of a set of members (excluding null/stale). */
function averageMemberOti(results: Array<OtiResult | null>): number | null {
  const values = results
    .map(r => (r && r.value !== null ? r.value : null))
    .filter((v): v is number => v !== null);
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Compute OTI for a team — simple average of member OTI values.
 * Members with no publishable value are excluded; returns null if none qualify.
 */
export async function computeTeamOti(teamId: string): Promise<number | null> {
  const db = await getTypedClient();
  const u = schema.users;
  const members = await db.select({ id: u.id }).from(u).where(eq(u.team_id, teamId));
  if (members.length === 0) return null;

  const byUser = await computeOtiForUsers(members.map(m => m.id));
  return averageMemberOti(members.map(m => byUser.get(m.id) ?? null));
}
