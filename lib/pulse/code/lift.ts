// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Value page "Observed signal (beta)" — a deterministic, org-level correlation
 * between AI engaged time and shipping rate. Explicitly NOT the benchmark
 * "Value (estimate)" headline (lib/pulse/code/value.ts) — this is a measured
 * (not judged, not benchmarked) but purely correlational signal, so it must
 * always be labelled "correlation, not causation" and shown separately.
 *
 * Method: take the last 8 COMPLETED calendar weeks of org-scope code_metrics
 * (granularity='week'; the current in-progress week is always excluded — see
 * lib/pulse/trends.ts convention). Split those weeks into an upper and lower
 * half by active_time_user_s (AI engaged time), then compare mean commits/week
 * between the two halves:
 *
 *   liftPct = (mean commits in high-AI-time weeks) / (mean commits in
 *              low-AI-time weeks) − 1
 *
 * Returns null unless there are at least 6 completed weeks with activity
 * (i.e. rows present) AND the low-half commit mean is > 0 (else the ratio is
 * undefined/infinite and would mislead).
 *
 * Async Drizzle on Postgres. `period_start`
 * is bigint(mode:'number') and `active_time_user_s`/`commit_count` are plain
 * `integer` columns on the Postgres schema — Drizzle's typed column codecs
 * already hand back JS numbers for all three, so no manual
 * Number() coercion is needed (this is a plain filtered SELECT, not a raw
 * SUM/COUNT aggregate).
 */
import { and, desc, eq, gte, ne } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { weekStart, weekStarts } from '@/lib/pulse/period';
import { ORG_SCOPE_ID } from '@/lib/pulse/code/aggregator';

export interface ObservedLift {
  liftPct: number;
  highWeeks: number;
  lowWeeks: number;
}

const LOOKBACK_WEEKS = 8;
const MIN_COMPLETED_WEEKS = 6;

interface WeekRow {
  period_start: number;
  active_time_user_s: number;
  commit_count: number;
}

export async function computeObservedLift(): Promise<ObservedLift | null> {
  const client = await getTypedClient();
  const now = Math.floor(Date.now() / 1000);
  const currentWeek = weekStart(now);
  // Look back further than 8 weeks so gaps don't shrink the completed-week count.
  const candidateWeeks = weekStarts(now, LOOKBACK_WEEKS + 4);
  const rangeStart = candidateWeeks[0];

  const t = schema.codeMetrics;
  const rows = await client
    .select({
      period_start: t.period_start,
      active_time_user_s: t.active_time_user_s,
      commit_count: t.commit_count,
    })
    .from(t)
    .where(and(
      eq(t.granularity, 'week'),
      eq(t.scope_type, 'organisation'),
      eq(t.scope_id, ORG_SCOPE_ID),
      gte(t.period_start, rangeStart),
      ne(t.period_start, currentWeek),
    ))
    .orderBy(desc(t.period_start));

  return computeFromRows(rows as WeekRow[]);
}

function computeFromRows(rows: WeekRow[]): ObservedLift | null {
  const completed = rows.slice(0, LOOKBACK_WEEKS);
  if (completed.length < MIN_COMPLETED_WEEKS) return null;

  const sorted = [...completed].sort((a, b) => a.active_time_user_s - b.active_time_user_s);
  const half = Math.floor(sorted.length / 2);
  const lowHalf = sorted.slice(0, half);
  const highHalf = sorted.slice(sorted.length - half);

  const mean = (ws: WeekRow[]) => ws.reduce((sum, w) => sum + w.commit_count, 0) / ws.length;
  const lowMean = mean(lowHalf);
  const highMean = mean(highHalf);

  if (lowMean <= 0) return null;

  return {
    liftPct: highMean / lowMean - 1,
    highWeeks: highHalf.length,
    lowWeeks: lowHalf.length,
  };
}
