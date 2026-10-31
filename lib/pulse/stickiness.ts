// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Product stickiness (DAU/MAU) per surface — how habitual usage is, not just
 * whether people have tried the product. All windows are UTC, computed from
 * `occurred_at` unix-epoch-seconds columns.
 *
 * - `mau`: distinct users active in the trailing 30 days (today inclusive).
 * - `avgDau`: mean of distinct-users-per-day over the trailing 7 *complete*
 *   days (yesterday backwards) — today's partial day is excluded so a
 *   half-elapsed day doesn't drag the average down.
 * - `stickiness`: avgDau / mau, rounded to 2dp. `null` (never NaN) when
 *   mau === 0 — there is nothing to be sticky about yet.
 *
 * The day-bucket GROUP BY uses
 * `to_char(to_timestamp(occurred_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD')` —
 * without the explicit UTC zone, to_char formats in the server's session
 * timezone and buckets can shift by a day near midnight UTC.
 */
import { sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { kindClause, vendorClause } from '@/lib/dashboard/product-sql';
import type { Vendor, WorkKind } from '@/lib/dashboard/vendor';

const DAY = 86400;

export interface SurfaceStickiness {
  avgDau: number;
  mau: number;
  stickiness: number | null;
}

interface SurfaceQuery {
  table: 'cowork_messages';
  where: string;
}

/**
 * One kind of work (lib/dashboard/vendor.ts) from the vendor: Chat is Claude
 * Chat and ChatGPT Chat, Work is Claude Cowork and ChatGPT Work, Code is
 * Claude Code and Codex.
 */
function surfaceQuery(kind: WorkKind, vendor: Vendor): SurfaceQuery {
  return {
    table: 'cowork_messages',
    where: `${kindClause(kind)} AND ${vendorClause(vendor)} AND user_id IS NOT NULL`,
  };
}

interface RawFacade {
  execute: (q: unknown) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}
async function rawAll<T>(client: unknown, query: unknown): Promise<T[]> {
  const c = client as RawFacade;
  const res = await c.execute(query);
  return res.rows as T[];
}

async function computeSurfaceStickiness(
  client: Awaited<ReturnType<typeof getTypedClient>>,
  surface: SurfaceQuery,
  nowEpochS: number,
): Promise<SurfaceStickiness> {
  const thirtyDaysAgo = nowEpochS - 30 * DAY;

  const mauQuery = sql`
    SELECT COUNT(DISTINCT user_id) as cnt
    FROM ${sql.raw(surface.table)}
    WHERE ${sql.raw(surface.where)} AND occurred_at >= ${thirtyDaysAgo}
  `;
  const mauRows = await rawAll<{ cnt: number | string }>(client, mauQuery);
  // Policy B: COUNT(DISTINCT ...) comes back as a string on pg.
  const mau = Number(mauRows[0]?.cnt ?? 0);

  // Trailing 7 complete days: yesterday backwards, excluding today's partial day.
  const todayStart = nowEpochS - (nowEpochS % DAY);
  const sevenDaysAgo = todayStart - 7 * DAY;

  const dayExpr = sql`to_char(to_timestamp(occurred_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

  const dailyQuery = sql`
    SELECT ${dayExpr} as day, COUNT(DISTINCT user_id) as cnt
    FROM ${sql.raw(surface.table)}
    WHERE ${sql.raw(surface.where)} AND occurred_at >= ${sevenDaysAgo} AND occurred_at < ${todayStart}
    GROUP BY day
  `;
  const dailyRows = await rawAll<{ day: string; cnt: number | string }>(client, dailyQuery);

  const totalUserDays = dailyRows.reduce((sum, r) => sum + Number(r.cnt), 0);
  const avgDau = totalUserDays / 7;

  const stickiness = mau === 0 ? null : Math.round((avgDau / mau) * 100) / 100;

  return { avgDau, mau, stickiness };
}

/** `cowork` is the Work kind of work; the key is kept for the route's callers. */
export async function getProductStickiness(nowEpochS: number = Math.floor(Date.now() / 1000), vendor: Vendor = 'all'): Promise<{
  cowork: SurfaceStickiness;
  code: SurfaceStickiness;
  chat: SurfaceStickiness;
}> {
  const client = await getTypedClient();
  const [cowork, code, chat] = await Promise.all([
    computeSurfaceStickiness(client, surfaceQuery('work', vendor), nowEpochS),
    computeSurfaceStickiness(client, surfaceQuery('code', vendor), nowEpochS),
    computeSurfaceStickiness(client, surfaceQuery('chat', vendor), nowEpochS),
  ]);
  return { cowork, code, chat };
}
