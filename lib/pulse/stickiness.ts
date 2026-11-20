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
 * Days are whole UTC days: `occurred_at / 86400` (an integer division), the
 * same day as `to_char(to_timestamp(occurred_at) AT TIME ZONE 'UTC', ...)`.
 *
 * Every figure, for each kind of work and each product, comes from one read of
 * the trailing 30 days: each person is listed once per day and product first,
 * and the counts are taken from that short list rather than from every prompt.
 */
import { sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { kindClause, vendorClause, productExpr } from '@/lib/dashboard/product-sql';
import { PRODUCT_IDS, type ProductId, type Vendor, type WorkKind } from '@/lib/dashboard/vendor';

const DAY = 86400;

export interface SurfaceStickiness {
  avgDau: number;
  mau: number;
  stickiness: number | null;
}

export interface KindStickiness {
  cowork: SurfaceStickiness;
  code: SurfaceStickiness;
  chat: SurfaceStickiness;
}

interface RawFacade {
  execute: (q: unknown) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}

/** A series' people in the 30 days and person-days in the 7 complete days. */
interface SeriesCounts { mau: number; userDays: number }

/**
 * One kind of work (lib/dashboard/vendor.ts) from the vendor, as a SQL
 * condition: Chat is Claude Chat and ChatGPT Chat, Work is Claude Cowork and
 * ChatGPT Work, Code is Claude Code and Codex. IS TRUE turns an unknown into false,
 * as a WHERE clause would.
 */
function kindFromVendor(kind: WorkKind, vendor: Vendor): string {
  return `(${kindClause(kind)} AND ${vendorClause(vendor)}) IS TRUE`;
}

/**
 * The counts behind every stickiness figure, keyed by series: a product id
 * ('claude_chat', ...) or a kind of work ('work', 'code', 'chat') from `vendor`.
 *
 *   person_days  each person once per day, product and kind of work (30 days)
 *   series_days  the same rows listed under every series they belong to
 *   monthly      people per series over the 30 days
 *   daily        person-days per series over the 7 complete days
 */
async function readStickinessSeries(nowEpochS: number, vendor: Vendor): Promise<Map<string, SeriesCounts>> {
  const thirtyDaysAgo = nowEpochS - 30 * DAY;
  // Trailing 7 complete days: yesterday backwards, excluding today's partial day.
  const todayDay = Math.floor(nowEpochS / DAY);

  const client = (await getTypedClient()) as unknown as RawFacade;
  const res = await client.execute(sql`
    WITH person_days AS (
      SELECT user_id, occurred_at / 86400 AS day, ${sql.raw(productExpr())} AS product,
             ${sql.raw(kindFromVendor('work', vendor))} AS in_work,
             ${sql.raw(kindFromVendor('code', vendor))} AS in_code,
             ${sql.raw(kindFromVendor('chat', vendor))} AS in_chat
      FROM cowork_messages
      WHERE user_id IS NOT NULL AND occurred_at >= ${thirtyDaysAgo}
      GROUP BY 1, 2, 3, 4, 5, 6
    ),
    series_days AS (
      SELECT product AS series, user_id, day FROM person_days
      UNION ALL SELECT 'work', user_id, day FROM person_days WHERE in_work
      UNION ALL SELECT 'code', user_id, day FROM person_days WHERE in_code
      UNION ALL SELECT 'chat', user_id, day FROM person_days WHERE in_chat
    ),
    monthly AS (
      SELECT series, COUNT(*) AS mau
      FROM (SELECT series, user_id FROM series_days GROUP BY 1, 2) people
      GROUP BY series
    ),
    daily AS (
      SELECT series, COUNT(*) AS user_days
      FROM (
        SELECT series, user_id, day FROM series_days
        WHERE day >= ${todayDay - 7} AND day < ${todayDay}
        GROUP BY 1, 2, 3
      ) person_day
      GROUP BY series
    )
    SELECT m.series, m.mau, COALESCE(d.user_days, 0) AS user_days
    FROM monthly m LEFT JOIN daily d ON d.series = m.series
  `);
  // Counts come back as strings on pg.
  const rows = res.rows as Array<{ series: string; mau: number | string; user_days: number | string }>;
  return new Map(rows.map((r) => [r.series, { mau: Number(r.mau), userDays: Number(r.user_days) }]));
}

function toStickiness(counts: SeriesCounts | undefined): SurfaceStickiness {
  const mau = counts?.mau ?? 0;
  const avgDau = (counts?.userDays ?? 0) / 7;
  const stickiness = mau === 0 ? null : Math.round((avgDau / mau) * 100) / 100;
  return { avgDau, mau, stickiness };
}

function kindsFrom(series: Map<string, SeriesCounts>): KindStickiness {
  return {
    cowork: toStickiness(series.get('work')),
    code: toStickiness(series.get('code')),
    chat: toStickiness(series.get('chat')),
  };
}

function productsFrom(series: Map<string, SeriesCounts>): Record<ProductId, SurfaceStickiness> {
  return Object.fromEntries(PRODUCT_IDS.map((id) => [id, toStickiness(series.get(id))])) as Record<ProductId, SurfaceStickiness>;
}

/** `cowork` is the Work kind of work; the key is kept for the route's callers. */
export async function getProductStickiness(nowEpochS: number = Math.floor(Date.now() / 1000), vendor: Vendor = 'all'): Promise<KindStickiness> {
  return kindsFrom(await readStickinessSeries(nowEpochS, vendor));
}

/** Stickiness for each of the six products the dashboard shows (lib/dashboard/vendor.ts). */
export async function getStickinessByProduct(nowEpochS: number = Math.floor(Date.now() / 1000)): Promise<Record<ProductId, SurfaceStickiness>> {
  return productsFrom(await readStickinessSeries(nowEpochS, 'all'));
}

/**
 * Both of the above from one read: each kind of work from `vendor`, and each of
 * the six products (which do not depend on the vendor switch).
 */
export async function getStickinessForDashboard(nowEpochS: number = Math.floor(Date.now() / 1000), vendor: Vendor = 'all'): Promise<{
  kinds: KindStickiness;
  products: Record<ProductId, SurfaceStickiness>;
}> {
  const series = await readStickinessSeries(nowEpochS, vendor);
  return { kinds: kindsFrom(series), products: productsFrom(series) };
}

/** The stickiness route's answer for one vendor view: the three kinds of work and the six products. */
export async function buildStickinessView(vendor: Vendor) {
  const { kinds: { cowork, code, chat }, products } = await getStickinessForDashboard(undefined, vendor);
  // Each of the six products on its own, for the dashboard's split view.
  return { cowork, code, chat, products, computedAt: Math.floor(Date.now() / 1000) };
}
