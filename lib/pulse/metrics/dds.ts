// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres, following the blessed query pattern (see lib/db/error-queries.ts,
// lib/db/queries.ts): getTypedClient() + schema.<table>, count/bigint→Number
// (Policy B) at every aggregate read.
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

// ─── Per-user DDS ─────────────────────────────────────────────────────────────

/**
 * Compute DDS (Delegation Depth Score) for a single user.
 *
 * DDS = ((T3 × 3) + (T2 × 2) + (T1 × 1)) / total tasks
 *
 * Rolling 14-day window. Returns null if no events in the window.
 */
export async function computeUserDds(userId: string): Promise<number | null> {
  const db = await getTypedClient();
  const pc = schema.pulseClassifications;
  const cm = schema.coworkMessages;

  const FOURTEEN_DAYS = 14 * 24 * 60 * 60; // seconds
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - FOURTEEN_DAYS;

  const rows = await db
    .select({
      t1: sql<number | string>`sum(case when ${pc.tier} = 1 then 1 else 0 end)`,
      t2: sql<number | string>`sum(case when ${pc.tier} = 2 then 1 else 0 end)`,
      t3: sql<number | string>`sum(case when ${pc.tier} = 3 then 1 else 0 end)`,
      total: sql<number | string>`count(*)`,
    })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .where(and(eq(pc.user_id, userId), eq(pc.classifier_status, 'classified'), gte(cm.occurred_at, windowStart)));

  const row = rows[0];
  const total = Number(row?.total ?? 0);
  if (total === 0) return null;

  const t1 = Number(row?.t1 ?? 0);
  const t2 = Number(row?.t2 ?? 0);
  const t3 = Number(row?.t3 ?? 0);

  return ((t3 * 3) + (t2 * 2) + (t1 * 1)) / total;
}

// ─── Batch DDS ────────────────────────────────────────────────────────────────

/**
 * Compute DDS for a set of users in one query instead of N.
 *
 * Semantics are identical to calling `computeUserDds(userId)` for each id in a
 * loop: same rolling 14-day window, same null-when-no-events rule. The event
 * fetch is batched with `GROUP BY user_id`; the per-user math is unchanged.
 *
 * Users with no rows in the window are not present in the GROUP BY result —
 * they are mapped to null explicitly so every requested id is present in the
 * returned Map.
 */
export async function computeDdsForUsers(userIds: string[]): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (userIds.length === 0) return result;

  for (const id of userIds) result.set(id, null);

  const db = await getTypedClient();
  const pc = schema.pulseClassifications;
  const cm = schema.coworkMessages;

  const FOURTEEN_DAYS = 14 * 24 * 60 * 60; // seconds
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - FOURTEEN_DAYS;

  const rows = await db
    .select({
      user_id: pc.user_id,
      t1: sql<number | string>`sum(case when ${pc.tier} = 1 then 1 else 0 end)`,
      t2: sql<number | string>`sum(case when ${pc.tier} = 2 then 1 else 0 end)`,
      t3: sql<number | string>`sum(case when ${pc.tier} = 3 then 1 else 0 end)`,
      total: sql<number | string>`count(*)`,
    })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .where(and(inArray(pc.user_id, userIds), eq(pc.classifier_status, 'classified'), gte(cm.occurred_at, windowStart)))
    .groupBy(pc.user_id);

  for (const row of rows) {
    const total = Number(row.total ?? 0);
    if (total === 0) {
      result.set(row.user_id, null);
      continue;
    }
    const t1 = Number(row.t1 ?? 0);
    const t2 = Number(row.t2 ?? 0);
    const t3 = Number(row.t3 ?? 0);
    result.set(row.user_id, ((t3 * 3) + (t2 * 2) + (t1 * 1)) / total);
  }

  return result;
}

// ─── Per-team DDS ─────────────────────────────────────────────────────────────

/**
 * Compute DDS for a team — simple average of member DDS values.
 * Members with null DDS (no events in the window) are excluded.
 * Returns null if no team members have a valid DDS.
 */
export async function computeTeamDds(teamId: string): Promise<number | null> {
  const db = await getTypedClient();
  const u = schema.users;

  const members = await db.select({ id: u.id }).from(u).where(eq(u.team_id, teamId));

  if (members.length === 0) return null;

  const ddsValues: number[] = [];
  for (const member of members) {
    const dds = await computeUserDds(member.id);
    if (dds !== null) ddsValues.push(dds);
  }

  if (ddsValues.length === 0) return null;

  return ddsValues.reduce((sum, v) => sum + v, 0) / ddsValues.length;
}
