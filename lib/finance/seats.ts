// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Wasted-seats estimate for FinOps (Workflow Impact package).
 *
 * Compares the admin-set `licensedSeats` count against the number of DISTINCT
 * users who have shown ANY activity (Cowork or Chat) in the trailing 30 days,
 * and — when an admin-set monthly seat price is configured — turns the
 * unused-seat count into a rough $ figure. This is deliberately an ESTIMATE,
 * for visibility only, never billing, and it never touches grandTotalUsd or
 * any chargeback/reconciliation invariant (computed here in the route layer,
 * never in lib/finance/chargeback.ts).
 *
 * "Active" is measured, not judged — a plain COUNT(DISTINCT user_id) union
 * across cowork_messages and chat_messages, the same two capture surfaces
 * CCC has first-party telemetry for (Code activity lives in cowork_messages
 * too, under surface='code', so it is already covered by that table).
 */
import { sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { getAllConfig } from '@/lib/config';

// ─── Raw-execution facade (mirrors lib/usecases/tracker.ts / lib/finance/chargeback.ts) ──
interface RawFacade {
  execute: (q: unknown) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}
async function rawAll<T>(client: unknown, query: unknown): Promise<T[]> {
  const c = client as RawFacade;
  const res = await c.execute(query);
  return res.rows as T[];
}

export interface SeatsSummary {
  licensed: number;
  activeUsers30d: number;
  unused: number;
  monthlyPriceUsd: number | null;
  estUnusedUsd: number | null;
}

const WINDOW_SECONDS = 30 * 86400;

/**
 * Pure. `unused` is clamped to >= 0 (more active users than licensed seats is
 * not "negative waste"). `estUnusedUsd` is unused × price, or null when price
 * is null — never fabricated when there is no price to multiply by.
 */
export function computeSeats(licensed: number, active: number, priceUsd: number | null): SeatsSummary {
  const unused = Math.max(0, licensed - active);
  const estUnusedUsd = priceUsd != null ? unused * priceUsd : null;
  return {
    licensed,
    activeUsers30d: active,
    unused,
    monthlyPriceUsd: priceUsd,
    estUnusedUsd,
  };
}

/**
 * null when `licensedSeats` is unset/invalid (not finite or <= 0) — mirrors
 * the dashboard's existing licensedSeats gate (app/api/dashboard/route.ts).
 * Short-circuits before any DB query in that case.
 */
export async function getSeatsSummary(nowS: number): Promise<SeatsSummary | null> {
  const config = await getAllConfig();

  const licensed = Number(config.licensedSeats);
  if (!Number.isFinite(licensed) || licensed <= 0) return null;

  const priceRaw = Number(config.finopsSeatPriceMonthly);
  const price = priceRaw > 0 ? priceRaw : null;

  const cutoff = nowS - WINDOW_SECONDS;
  const db = await getTypedClient();
  // COUNT/UNION come back as bigint -> STRING on Postgres; Number()-coerce.
  const rows = await rawAll<{ c: number | string | null }>(
    db,
    sql`SELECT COUNT(DISTINCT user_id) AS c FROM (
          SELECT user_id FROM cowork_messages WHERE occurred_at >= ${cutoff} AND user_id IS NOT NULL
          UNION
          SELECT user_id FROM chat_messages WHERE occurred_at >= ${cutoff} AND user_id IS NOT NULL
        ) AS active_users`
  );
  const active = Number(rows[0]?.c ?? 0);

  return computeSeats(licensed, active, price);
}
