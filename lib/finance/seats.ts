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
 * "Active" is measured, not judged — a plain COUNT(DISTINCT user_id) over
 * cowork_messages, which holds every captured prompt: Cowork, Code
 * (surface='code') and Claude Chat (surface='chat'). ChatGPT and Codex
 * prompts live there too and are left out: they use no Claude seat.
 *
 * The ChatGPT licence (getChatgptSeatsSummary) is the same idea for ChatGPT
 * Enterprise: seats x the admin-set monthly seat price, which OpenAI charges
 * apart from usage. Shown beside usage spend, never added to it.
 */
import { sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { getAllConfig } from '@/lib/config';
import { OPENAI_SOURCES } from '@/lib/openai/sources';

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
    sql`SELECT COUNT(DISTINCT user_id) AS c FROM cowork_messages
        WHERE occurred_at >= ${cutoff} AND user_id IS NOT NULL
          AND (source IS NULL OR source NOT IN (${sql.join(OPENAI_SOURCES.map(s => sql`${s}`), sql`, `)}))`
  );
  const active = Number(rows[0]?.c ?? 0);

  return computeSeats(licensed, active, price);
}

export interface ChatgptSeatsSummary extends SeatsSummary {
  /** seats x monthly price: the month's licence charge. null without a price. */
  monthlyLicenceUsd: number | null;
}

/**
 * The ChatGPT Enterprise licence: null when `chatgptSeats` is unset or
 * invalid. Active = people with a ChatGPT Chat or Work prompt in the last 30
 * days (Codex has no seat of its own here).
 */
export async function getChatgptSeatsSummary(nowS: number): Promise<ChatgptSeatsSummary | null> {
  const config = await getAllConfig();
  const licensed = Number(config.chatgptSeats);
  if (!Number.isFinite(licensed) || licensed <= 0) return null;
  const priceRaw = Number(config.chatgptSeatPriceMonthly);
  const price = priceRaw > 0 ? priceRaw : null;

  const cutoff = nowS - WINDOW_SECONDS;
  const db = await getTypedClient();
  const rows = await rawAll<{ c: number | string | null }>(
    db,
    sql`SELECT COUNT(DISTINCT user_id) AS c FROM cowork_messages
        WHERE occurred_at >= ${cutoff} AND user_id IS NOT NULL
          AND source IN ('chatgpt_chat', 'chatgpt_work')`
  );
  const seats = computeSeats(licensed, Number(rows[0]?.c ?? 0), price);
  return { ...seats, monthlyLicenceUsd: price != null ? licensed * price : null };
}
