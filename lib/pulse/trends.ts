// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Weekly trend read helper — reads the `granularity='week'` rows written by
 * both aggregators (lib/pulse/code/aggregator.ts, lib/pulse/aggregator.ts).
 * Never touches rolling rows.
 *
 * CASCADE-HEAVY: getWeeklySeries/getWeeklyDelta are shared plumbing across
 * Pulse pages, digest, connector, and code routes — every caller was
 * confirmed and awaited (see task-3.7e-report.md for the full list).
 *
 * `table` and `column` are raw SQL identifiers (not parameter values, so they
 * can't be bound placeholders) — `table` is the internal TrendTable union
 * (never user input) and `column` is checked against COLUMN_ALLOWLIST via
 * assertColumn() BEFORE being interpolated with sql.raw(), so this stays safe
 * against injection exactly like the pre-conversion string-template SQL did.
 */
import { sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { weekStart, weekStarts } from '@/lib/pulse/period';

export type TrendTable = 'code_metrics' | 'pulse_metrics';

/** Hard allowlist per table — defends against SQL injection via `column`. */
const COLUMN_ALLOWLIST: Record<TrendTable, readonly string[]> = {
  code_metrics: [
    'spend_usd', 'autonomy_ratio', 'session_count', 'commit_count',
    'pr_count', 'lines_added', 'friction_index', 'active_time_user_s',
  ],
  pulse_metrics: ['dds', 'event_count', 'tier_2_count', 'tier_3_count'],
};

function assertColumn(table: TrendTable, column: string): void {
  if (!COLUMN_ALLOWLIST[table].includes(column)) {
    throw new Error(`Column "${column}" is not allowlisted for trend reads on ${table}`);
  }
}

/**
 * Guard for hand-rolled `pulse_metrics` SQL outside this module (e.g. the CIO
 * route's org-wide weekly-volume aggregation, which sums columns itself
 * rather than going through getWeeklySeries/getWeeklyDelta). Reuses the same
 * COLUMN_ALLOWLIST so there is exactly one allowlist to keep in sync.
 */
export function assertPulseMetricsColumn(column: string): void {
  assertColumn('pulse_metrics', column);
}

export interface WeeklyPoint {
  weekStart: number;
  value: number | null;
  partial: boolean;
}

interface RawFacade {
  execute: (q: unknown) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}
async function rawAll<T>(client: unknown, query: unknown): Promise<T[]> {
  const c = client as RawFacade;
  const res = await c.execute(query);
  return res.rows as T[];
}

/**
 * Last nWeeks calendar weeks for a scope, one entry per week (missing weeks
 * -> value null). The current (in-progress) week is marked partial: true.
 *
 * `now` defaults to the current time; callers that need a fixed reference
 * clock (e.g. the digest builder, so its own `now` param actually determines
 * which weeks are compared) can pass it explicitly.
 */
export async function getWeeklySeries(
  table: TrendTable,
  scopeType: string,
  scopeId: string,
  column: string,
  nWeeks: number,
  now: number = Math.floor(Date.now() / 1000),
): Promise<WeeklyPoint[]> {
  assertColumn(table, column);
  const client = await getTypedClient();
  const weeks = weekStarts(now, nWeeks);
  const currentWeek = weekStart(now);

  const query = sql`
    SELECT period_start, ${sql.raw(column)} AS value FROM ${sql.raw(table)}
    WHERE granularity = 'week' AND scope_type = ${scopeType} AND scope_id = ${scopeId} AND period_start >= ${weeks[0]}
    ORDER BY period_start
  `;
  // Policy B: period_start (bigint) and value (numeric/bigint columns, e.g.
  // code_metrics.spend_usd) both come back as STRINGS from a raw pg query —
  // Number()-coerce both at the read site.
  const rows = await rawAll<{ period_start: number | string; value: number | string | null }>(client, query);

  const byWeek = new Map(rows.map(r => [Number(r.period_start), r.value === null ? null : Number(r.value)]));

  return weeks.map(ws => ({
    weekStart: ws,
    value: byWeek.has(ws) ? byWeek.get(ws)! : null,
    partial: ws === currentWeek,
  }));
}

export interface WeeklyDelta {
  current: number | null;
  prior: number | null;
  pct: number | null;
}

/**
 * Compares the two most recent COMPLETED weeks (never the partial current
 * week). pct is null when prior is null or 0.
 *
 * `now` defaults to the current time; pass explicitly to pin the reference
 * clock (see getWeeklySeries).
 */
export async function getWeeklyDelta(
  table: TrendTable,
  scopeType: string,
  scopeId: string,
  column: string,
  nWeeks: number,
  now: number = Math.floor(Date.now() / 1000),
): Promise<WeeklyDelta> {
  // assertColumn happens inside getWeeklySeries; nWeeks+1 not needed since we
  // only ever look at completed weeks within the requested series and drop
  // the trailing (partial) entry.
  const series = await getWeeklySeries(table, scopeType, scopeId, column, nWeeks, now);
  const completed = series.filter(p => !p.partial);
  const current = completed.length > 0 ? completed[completed.length - 1].value : null;
  const prior = completed.length > 1 ? completed[completed.length - 2].value : null;
  const pct = prior !== null && prior !== 0 && current !== null ? (current - prior) / prior : null;
  return { current, prior, pct };
}
