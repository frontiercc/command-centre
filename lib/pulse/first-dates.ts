// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Each person's first date and first meaningful date, kept past retention (migration 0057).
//
// So What's "waves" group people by the month of their first Work Pulse prompt the classifier
// judged (or first Developer Pulse session) and measure how long they took to reach meaningful
// work. Retention deletes those prompts and sessions, so on its own the waves would read the
// first date STILL KEPT, and everyone who started before the retention window would look as if
// they had started in its oldest month. Retention calls keepFirstDates() just before it deletes,
// and the waves read the earlier of these kept dates and what is still in the tables.
//
// Dates only, never content. Erasure deletes a person's rows (deleteUserData).
import { PC_MESSAGE } from '@/lib/pulse/classification-message';
import { sql, type SQL } from 'drizzle-orm';
import type { Vendor } from '@/lib/dashboard/vendor';
import { vendorClause } from '@/lib/dashboard/product-sql';
import { isWorkPulseSurface } from '@/lib/pulse/work-surfaces';
import { getConfigValue } from '@/lib/config';

export type FirstDatesSurface = 'work' | 'code';

interface Executor { execute: (query: SQL) => Promise<unknown> }

/** Keeps the earlier of what is already kept and what is offered. LEAST skips a NULL. */
const KEEP_EARLIEST = sql`
  ON CONFLICT (surface, user_id, vendor) DO UPDATE SET
    first_at = LEAST(pulse_first_dates.first_at, EXCLUDED.first_at),
    first_deep_at = LEAST(pulse_first_dates.first_deep_at, EXCLUDED.first_deep_at)`;

/**
 * Copies the first dates out of the rows retention is about to delete: Work Pulse prompts sent
 * before `workBefore` and Developer Pulse sessions that ended before `codeBefore`. Run inside
 * retention's transaction, before its deletes, so a date is kept or nothing is deleted.
 */
export async function keepFirstDates(db: Executor, cutoffs: { workBefore: number; codeBefore: number }): Promise<void> {
  await db.execute(sql`
    INSERT INTO pulse_first_dates (surface, user_id, vendor, first_at, first_deep_at)
    SELECT 'work', pc.user_id,
           CASE WHEN ${sql.raw(vendorClause('openai', 'cm.'))} THEN 'openai' ELSE 'claude' END,
           MIN(cm.occurred_at),
           MIN(CASE WHEN pc.tier >= 2 THEN cm.occurred_at END)
    FROM pulse_classifications pc
    ${PC_MESSAGE}
    WHERE pc.classifier_status = 'classified' AND pc.user_id IS NOT NULL
      AND ${isWorkPulseSurface(sql`cm.surface`, true)}
      AND cm.occurred_at < ${cutoffs.workBefore}
    GROUP BY 2, 3
    ${KEEP_EARLIEST}
  `);
  await db.execute(sql`
    INSERT INTO pulse_first_dates (surface, user_id, vendor, first_at, first_deep_at)
    SELECT 'code', css.user_id,
           CASE WHEN css.session_id LIKE 'codex:%' THEN 'openai' ELSE 'claude' END,
           MIN(css.first_at),
           MIN(CASE WHEN csc.tier >= 2 THEN css.first_at END)
    FROM code_session_stats css
    LEFT JOIN code_session_classifications csc ON csc.session_id = css.session_id AND csc.status = 'classified'
    WHERE css.user_id IS NOT NULL AND css.last_at < ${cutoffs.codeBefore}
    GROUP BY 2, 3
    ${KEEP_EARLIEST}
  `);
}

/**
 * The kept first dates for one surface in a vendor view, as rows of (user_id, first_at,
 * first_deep_at), for a UNION ALL with the live query; the waves take each person's earliest.
 */
export function keptFirstDates(surface: FirstDatesSurface, vendor: Vendor): SQL {
  const inView = vendor === 'all' ? sql`TRUE` : sql`vendor = ${vendor}`;
  return sql`SELECT user_id, first_at, first_deep_at FROM pulse_first_dates WHERE surface = ${surface} AND ${inView}`;
}

const FROM_KEY = { work: 'pulseFirstDatesWorkFrom', code: 'pulseFirstDatesCodeFrom' } as const;

/**
 * From when one surface's first dates are complete (epoch seconds), or null if not recorded.
 * Retention had already deleted anything older than its window before these dates were kept,
 * so migration 0057 records the window's start on a hub being upgraded.
 */
export async function firstDatesCompleteFrom(surface: FirstDatesSurface): Promise<number | null> {
  const v = parseInt(await getConfigValue(FROM_KEY[surface]), 10);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Only the waves that can be measured: a month that started before the dates were complete
 * could hold anyone who started earlier, so it is left out rather than shown wrong.
 */
export function measurableWaves<T extends { month: string }>(waves: T[], completeFrom: number | null): T[] {
  if (completeFrom === null) return waves;
  return waves.filter(w => Date.parse(`${w.month}-01T00:00:00Z`) / 1000 >= completeFrom);
}
