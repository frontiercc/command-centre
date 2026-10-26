// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Person 360 — a read-only cross-surface assembly of EXISTING data (Cowork
 * Pulse, Developer Pulse, Chat, combined spend). No new writes, no new tables —
 * this purely joins the latest rolling snapshots + the weekly-trend
 * helper (lib/pulse/trends.ts) for one user.
 *
 * Async Drizzle on Postgres.
 */
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getWeeklySeries, type WeeklyPoint } from '@/lib/pulse/trends';
import { getCoworkCostUsd } from '@/lib/pulse/aggregator';

export type SeriesPoint = WeeklyPoint;

export interface Person360 {
  userId: string;
  displayName: string | null;
  department: string | null;
  cowork: { tierCounts: { t1: number; t2: number; t3: number }; dds: number | null; oti: number | null } | null;
  code: {
    spendUsd: number | null; sessions: number; commits: number; autonomy: number | null;
    engagedHours: number | null; linesAdded: number; editAcceptRate: number | null;
  } | null;
  chat: { messages7d: number } | null;
  combinedSpend: { codeUsd: number | null; coworkUsd: number; totalUsd: number | null; totalIsPartial?: boolean };
  weekly: { codeSpend: SeriesPoint[]; coworkEvents: SeriesPoint[] };
}

const WEEKLY_LOOKBACK = 8;

export async function getPerson360(userId: string): Promise<Person360> {
  const client = await getTypedClient();
  const now = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = now - 7 * 24 * 3600;

  const u = schema.users;
  const userRows = await client
    .select({ display_name: u.display_name, department: u.department })
    .from(u)
    .where(eq(u.id, userId))
    .limit(1);
  const userRow = userRows[0];

  const displayName = userRow?.display_name ?? null;
  const department = userRow?.department ?? null;

  // Cowork — latest user-scope rolling pulse_metrics row.
  const pm = schema.pulseMetrics;
  const coworkRows = await client
    .select({
      dds: pm.dds,
      oti: pm.oti,
      tier_1_count: pm.tier_1_count,
      tier_2_count: pm.tier_2_count,
      tier_3_count: pm.tier_3_count,
    })
    .from(pm)
    .where(and(eq(pm.scope_type, 'user'), eq(pm.scope_id, userId), eq(pm.granularity, 'rolling')))
    .orderBy(desc(pm.computed_at))
    .limit(1);
  const coworkRow = coworkRows[0];

  const cowork = coworkRow
    ? {
        tierCounts: { t1: coworkRow.tier_1_count, t2: coworkRow.tier_2_count, t3: coworkRow.tier_3_count },
        dds: coworkRow.dds,
        oti: coworkRow.oti,
      }
    : null;

  // Code — latest user-scope rolling code_metrics row.
  const cm = schema.codeMetrics;
  const codeRows = await client
    .select({
      spend_usd: cm.spend_usd,
      session_count: cm.session_count,
      commit_count: cm.commit_count,
      autonomy_ratio: cm.autonomy_ratio,
      active_time_user_s: cm.active_time_user_s,
      active_time_cli_s: cm.active_time_cli_s,
      lines_added: cm.lines_added,
      edit_accept_count: cm.edit_accept_count,
      edit_reject_count: cm.edit_reject_count,
    })
    .from(cm)
    .where(and(eq(cm.scope_type, 'user'), eq(cm.scope_id, userId), eq(cm.granularity, 'rolling')))
    .orderBy(desc(cm.computed_at))
    .limit(1);
  const codeRow = codeRows[0];

  const code = codeRow
    ? {
        // spend_usd is `numeric` on Postgres (returned as a STRING) — Number()-coerce at the read site.
        spendUsd: codeRow.spend_usd !== null && codeRow.spend_usd !== undefined ? Number(codeRow.spend_usd) : null,
        sessions: codeRow.session_count,
        commits: codeRow.commit_count,
        autonomy: codeRow.autonomy_ratio,
        engagedHours: (codeRow.active_time_user_s + codeRow.active_time_cli_s) / 3600,
        linesAdded: codeRow.lines_added,
        editAcceptRate: (codeRow.edit_accept_count + codeRow.edit_reject_count) > 0
          ? codeRow.edit_accept_count / (codeRow.edit_accept_count + codeRow.edit_reject_count)
          : null,
      }
    : null;

  // Chat — message count in the last 7 days.
  const chat_t = schema.chatMessages;
  const chatRows = await client
    .select({ cnt: sql<number | string>`count(*)` })
    .from(chat_t)
    .where(and(eq(chat_t.user_id, userId), gte(chat_t.occurred_at, sevenDaysAgo)));
  // Policy B: COUNT(*) comes back as a string on pg.
  const chat = { messages7d: Number(chatRows[0]?.cnt ?? 0) };

  // Combined spend: code (priced) + cowork (OTel-priced), 7-day window.
  const codeUsd = code?.spendUsd ?? null;
  const coworkUsd = await getCoworkCostUsd(userId, sevenDaysAgo, now);

  let totalUsd: number | null;
  let totalIsPartial: boolean | undefined;
  if (codeUsd !== null) {
    totalUsd = codeUsd + coworkUsd;
  } else if (coworkUsd > 0) {
    // Code spend unknown (unpriced model or no code data) but cowork spend is
    // real — total is a known underestimate; the UI must flag this.
    totalUsd = coworkUsd;
    totalIsPartial = true;
  } else {
    totalUsd = null;
  }

  const combinedSpend: Person360['combinedSpend'] = { codeUsd, coworkUsd, totalUsd };
  if (totalIsPartial) combinedSpend.totalIsPartial = true;

  // Weekly 8-week sparkline series.
  const [codeSpend, coworkEvents] = await Promise.all([
    getWeeklySeries('code_metrics', 'user', userId, 'spend_usd', WEEKLY_LOOKBACK),
    getWeeklySeries('pulse_metrics', 'user', userId, 'event_count', WEEKLY_LOOKBACK),
  ]);
  const weekly = { codeSpend, coworkEvents };

  return { userId, displayName, department, cowork, code, chat, combinedSpend, weekly };
}
