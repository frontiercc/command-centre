// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Governance Health endpoint — the automated governance-health score.
//
// Measures whether governance infrastructure is being actively used, derived
// entirely from observable system activity (no manual input required).
//
// Four components:
//   1. Queue review latency  — median hours to action capability creation candidates
//   2. Alert acknowledgment  — fraction of alerts resolved in the last 30 days
//   3. Queue health          — unreviewed capability backlog (size + growth trend)
//   4. Reviewer spread       — how many distinct people are actioning reviews
//
// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table> +
// query-builder aggregates (COUNT/SUM via `sql<number | string>` — no GROUP
// BY here). Every aggregate is Number()-coerced (bigint/numeric
// come back as STRINGS on Postgres).
import { NextRequest, NextResponse } from 'next/server';
import { and, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { getAdminSession } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

export const dynamic = 'force-dynamic';

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Clamp a value to [0, 1]. */
function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // Managers and admins only — governance view
  if (!['admin', 'manager'].includes(session.role ?? '')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const client = await getTypedClient();
  const now = Math.floor(Date.now() / 1000);
  const THIRTY_DAYS = 30 * 24 * 3600;
  const SEVEN_DAYS  = 7  * 24 * 3600;
  const windowStart = now - THIRTY_DAYS;
  const sevenDaysAgo = now - SEVEN_DAYS;

  const pe = schema.pulseEvents;
  const a = schema.alerts;

  // ── 1. Queue review latency ───────────────────────────────────────────────
  // Capability creation events that have been actioned (confirmed or dismissed)
  // in the last 30 days.
  const actionedEvents = await client
    .select({ detected_at: pe.detected_at, confirmed_at: pe.confirmed_at })
    .from(pe)
    .where(and(
      eq(pe.event_type, 'capability_creation'),
      inArray(pe.status, ['confirmed', 'dismissed']),
      isNotNull(pe.confirmed_at),
      gte(pe.confirmed_at, windowStart),
    ));

  const latencyHours = actionedEvents.map(e =>
    (e.confirmed_at! - e.detected_at) / 3600
  );
  const medianLatencyHours = median(latencyHours);

  // Score: 1.0 if ≤24h, 0.0 if ≥168h (7 days), linear between
  const latencyScore = medianLatencyHours === null
    ? null
    : clamp(1 - (medianLatencyHours - 24) / (168 - 24));

  // ── 2. Alert acknowledgment rate ─────────────────────────────────────────
  const alertCountsRows = await client
    .select({
      total: sql<number | string>`COUNT(*)`,
      resolved: sql<number | string>`SUM(CASE WHEN ${a.status} = 'resolved' THEN 1 ELSE 0 END)`,
    })
    .from(a)
    .where(gte(a.generated_at, windowStart));

  const alertTotal    = Number(alertCountsRows[0]?.total ?? 0);
  const alertResolved = Number(alertCountsRows[0]?.resolved ?? 0);
  const acknowledgmentRate = alertTotal > 0 ? alertResolved / alertTotal : null;

  // ── 3. Queue health (pending backlog + growth trend) ─────────────────────
  const pendingNowRows = await client
    .select({ cnt: sql<number | string>`COUNT(*)` })
    .from(pe)
    .where(and(eq(pe.event_type, 'capability_creation'), eq(pe.status, 'candidate')));
  const pendingNow = Number(pendingNowRows[0]?.cnt ?? 0);

  const pendingSevenDaysAgoRows = await client
    .select({ cnt: sql<number | string>`COUNT(*)` })
    .from(pe)
    .where(and(eq(pe.event_type, 'capability_creation'), eq(pe.status, 'candidate'), lte(pe.detected_at, sevenDaysAgo)));
  const pendingSevenDaysAgo = Number(pendingSevenDaysAgoRows[0]?.cnt ?? 0);

  // Queue score: 1.0 if 0 pending, decays with backlog size
  // Also penalise if backlog is growing
  const queueSizeScore = clamp(1 - pendingNow / 10); // 10+ items → 0
  const queueTrend = pendingNow - pendingSevenDaysAgo; // positive = growing
  const queueTrendPenalty = queueTrend > 0 ? clamp(queueTrend / 5) * 0.2 : 0;
  const queueScore = clamp(queueSizeScore - queueTrendPenalty);

  // ── 4. Reviewer spread ────────────────────────────────────────────────────
  const reviewerRows = await client
    .select({ reviewer_count: sql<number | string>`COUNT(DISTINCT ${pe.confirmed_by})` })
    .from(pe)
    .where(and(
      inArray(pe.status, ['confirmed', 'dismissed']),
      gte(pe.confirmed_at, windowStart),
      isNotNull(pe.confirmed_by),
    ));

  const reviewerCount = Number(reviewerRows[0]?.reviewer_count ?? 0);
  // Score: 0.2 if 1 reviewer, 0.6 if 2, 1.0 if 3+
  const reviewerSpreadScore = reviewerCount === 0 ? null
    : reviewerCount === 1 ? 0.2
    : reviewerCount === 2 ? 0.6
    : 1.0;

  // ── Composite governance-health score ─────────────────────────────────────
  // Average of available non-null components. queueScore always available.
  const components: number[] = [queueScore];
  if (latencyScore !== null)       components.push(latencyScore);
  if (acknowledgmentRate !== null) components.push(acknowledgmentRate);
  if (reviewerSpreadScore !== null) components.push(reviewerSpreadScore);

  const governanceScore = components.reduce((sum, v) => sum + v, 0) / components.length;

  return NextResponse.json({
    governanceScore: Math.round(governanceScore * 1000) / 1000,
    components: {
      queue_review_latency: {
        median_hours: medianLatencyHours !== null ? Math.round(medianLatencyHours * 10) / 10 : null,
        score: latencyScore !== null ? Math.round(latencyScore * 1000) / 1000 : null,
        actioned_in_window: actionedEvents.length,
      },
      alert_acknowledgment: {
        rate: acknowledgmentRate !== null ? Math.round(acknowledgmentRate * 1000) / 1000 : null,
        total_alerts: alertTotal,
        resolved_alerts: alertResolved,
      },
      queue_health: {
        pending_now: pendingNow,
        pending_7d_ago: pendingSevenDaysAgo,
        trend: queueTrend,
        score: Math.round(queueScore * 1000) / 1000,
      },
      reviewer_spread: {
        distinct_reviewers: reviewerCount,
        score: reviewerSpreadScore,
      },
    },
    thresholds: {
      warning: 0.5,
      critical: 0.3,
    },
    note: 'Governance Health is an automated, observable-activity-only score. A fuller governance score (including confidence declarations and reviewer rotation compliance) activates when the review workflow is enabled.',
  });
}
