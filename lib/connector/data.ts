// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Read-only, org-level (never per-user) data layer for the CCC Metrics
 * Connector. Wraps existing Code/Work Pulse aggregates — no new
 * computation, no classifier, no per-user identity ever surfaced.
 */
import { sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { buildDigest } from '@/lib/digest/build';
import { getWeeklySeries, assertPulseMetricsColumn, type WeeklyPoint } from '@/lib/pulse/trends';
import { weekStart, weekStarts } from '@/lib/pulse/period';
import { ORG_SCOPE_ID } from '@/lib/pulse/code/aggregator';
import { getCodePulseHealth } from '@/lib/pulse/code/health';

// ─── Phase 3 raw-execution facade (mirrors lib/db/queries.ts's rawAll) ────────
interface RawFacade {
  execute: (q: unknown) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}
async function rawAll<T>(client: unknown, query: unknown): Promise<T[]> {
  const c = client as RawFacade;
  const res = await c.execute(query);
  return res.rows as T[];
}

/** Metrics sourced from code_metrics at 'organisation' scope via getWeeklySeries. */
const CODE_METRICS_ALLOWLIST = [
  'spend_usd',
  'commit_count',
  'pr_count',
  'session_count',
  'active_time_user_s',
] as const;

/** Metrics summed across pulse_metrics 'user'-scope weekly rows. */
const PULSE_METRICS_SUM_ALLOWLIST = ['event_count', 'tier_3_count'] as const;

/** Full allowlist of metrics the connector trend endpoint accepts. */
export const CONNECTOR_METRIC_ALLOWLIST = [
  ...CODE_METRICS_ALLOWLIST,
  ...PULSE_METRICS_SUM_ALLOWLIST,
] as const;

export type ConnectorMetric = (typeof CONNECTOR_METRIC_ALLOWLIST)[number];

/** Thrown when a caller requests a metric outside CONNECTOR_METRIC_ALLOWLIST. */
export class InvalidMetricError extends Error {
  constructor(metric: string) {
    super(`"${metric}" is not a supported connector trend metric`);
    this.name = 'InvalidMetricError';
  }
}

function isCodeMetricsMetric(metric: string): metric is (typeof CODE_METRICS_ALLOWLIST)[number] {
  return (CODE_METRICS_ALLOWLIST as readonly string[]).includes(metric);
}

function isPulseSumMetric(metric: string): metric is (typeof PULSE_METRICS_SUM_ALLOWLIST)[number] {
  return (PULSE_METRICS_SUM_ALLOWLIST as readonly string[]).includes(metric);
}

function clampWeeks(weeks: number | undefined): number {
  if (weeks === undefined || !Number.isFinite(weeks)) return 8;
  if (weeks < 1) return 1;
  if (weeks > 26) return 26;
  return Math.floor(weeks);
}

/**
 * Org-level weekly digest snapshot — same underlying data as the weekly exec
 * digest, minus the LLM-generated briefing excerpt (deliberately excluded:
 * free text could reference individuals) and minus the anomaly's occurredAt
 * (title + severity only). The anomaly title is further suppressed here
 * (title: null) whenever the underlying alert is linked to a specific user
 * (alerts.user_id NOT NULL) — anomaly-detection alert titles routinely name
 * an individual (e.g. "Unusual activity involving <name>"), and this is the
 * ONLY surface where the org-only guarantee must hold structurally rather
 * than by convention. The digest email keeps the title regardless of
 * userLinked — this filtering is connector-only.
 */
export async function getConnectorSummary(now: number = Math.floor(Date.now() / 1000)): Promise<object> {
  const digest = await buildDigest(now);

  if (!digest) {
    return {
      weekStart: null,
      weekEnd: null,
      code: null,
      cowork: null,
      anomaly: null,
      humanTime: null,
      generatedAt: now,
    };
  }

  return {
    weekStart: digest.weekStart,
    weekEnd: digest.weekEnd,
    code: digest.code,
    cowork: digest.cowork,
    anomaly: digest.anomaly
      ? { severity: digest.anomaly.severity, title: digest.anomaly.userLinked ? null : digest.anomaly.title }
      : null,
    // Human time vs Claude time: org totals and org-level
    // kinds of work only — no person or session. humanMinutes are AI
    // ESTIMATES; claudeMinutes are MEASURED. Null when switched off or empty.
    humanTime: digest.humanTime
      ? {
          note: 'humanMinutes are AI estimates of by-hand time; claudeMinutes are measured active time. Tier 2 and 3 sessions only.',
          code: digest.humanTime.code,
          cowork: digest.humanTime.cowork,
          total: digest.humanTime.total,
        }
      : null,
    generatedAt: now,
  };
}

async function getPulseSumSeries(metric: string, weeks: number, now: number): Promise<WeeklyPoint[]> {
  // assertPulseMetricsColumn() allowlists `metric` BEFORE it is interpolated
  // with sql.raw() — no user-controlled identifier ever reaches the SQL text.
  assertPulseMetricsColumn(metric);
  const db = await getTypedClient();
  const targetWeeks = weekStarts(now, weeks);
  const currentWeek = weekStart(now);

  // Policy B: period_start (bigint) and SUM(...) (bigint) both come back as
  // STRINGS from a raw pg query — Number()-coerce both at the read site.
  const rows = await rawAll<{ period_start: number | string; value: number | string | null }>(
    db,
    sql`SELECT period_start, SUM(${sql.raw(metric)}) AS value FROM pulse_metrics
     WHERE granularity = 'week' AND scope_type = 'user' AND period_start >= ${targetWeeks[0]}
     GROUP BY period_start`
  );

  const byWeek = new Map(rows.map((r) => [Number(r.period_start), r.value === null ? null : Number(r.value)]));

  // Missing weeks contribute 0, not null — matches the CIO route's
  // org-wide weekly volume convention (app/api/pulse/cio/route.ts).
  return targetWeeks.map((ws) => ({
    weekStart: ws,
    value: byWeek.has(ws) ? (byWeek.get(ws) ?? 0) : 0,
    partial: ws === currentWeek,
  }));
}

/** Org-level weekly trend for one allowlisted metric. Throws InvalidMetricError otherwise. */
export async function getConnectorTrend(
  metric: string,
  weeks?: number,
  now: number = Math.floor(Date.now() / 1000)
): Promise<{ metric: string; weeks: number; series: WeeklyPoint[] }> {
  if (!(CONNECTOR_METRIC_ALLOWLIST as readonly string[]).includes(metric)) {
    throw new InvalidMetricError(metric);
  }

  const clampedWeeks = clampWeeks(weeks);

  const series = isCodeMetricsMetric(metric)
    ? await getWeeklySeries('code_metrics', 'organisation', ORG_SCOPE_ID, metric, clampedWeeks, now)
    : isPulseSumMetric(metric)
      ? await getPulseSumSeries(metric, clampedWeeks, now)
      : (() => { throw new InvalidMetricError(metric); })();

  return { metric, weeks: clampedWeeks, series };
}

/** Aggregate-only Developer Pulse data-health snapshot — no per-user data. */
export async function getConnectorHealth(): Promise<object> {
  return getCodePulseHealth();
}
