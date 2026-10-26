// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// app/api/pulse/code/framework/route.ts
// Dev Framework Alignment — composes the measured Developer Pulse crosswalk
// (lib/pulse/code/framework.ts) with the optional getDX overlay
// (lib/pulse/code/dx-framework.ts) into one JSON envelope. Org-scope only
// (no per-user data). Follows the standard pattern also
// used by app/api/pulse/code/org-summary/route.ts: getTypedClient() +
// schema.<table>, Drizzle query builder, Number()-coerced aggregates
// (Postgres returns bigint and numeric as strings). Ships dormant behind `dxFrameworkEnabled` (default false).
import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { getAdminSession, canAccessOrgOverview } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getAllConfig } from '@/lib/config';
import { buildCrosswalk, computeEngagedHours, type CodeSignals } from '@/lib/pulse/code/framework';
import { getDxFramework } from '@/lib/pulse/code/dx-framework';
import { ORG_SCOPE_ID } from '@/lib/pulse/code/aggregator';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessOrgOverview(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const cfg = await getAllConfig();
  if (!cfg.dxFrameworkEnabled) {
    return NextResponse.json({ enabled: false }, { status: 200 });
  }

  const client = await getTypedClient();
  const cm = schema.codeMetrics;

  // Latest rolling org-scope code_metrics row — same source + column set as
  // app/api/pulse/code/org-summary/route.ts.
  const metricsCols = {
    spend_usd: cm.spend_usd,
    autonomy_ratio: cm.autonomy_ratio,
    cache_hit_ratio: cm.cache_hit_ratio,
    commit_count: cm.commit_count,
    pr_count: cm.pr_count,
    lines_added: cm.lines_added,
    lines_removed: cm.lines_removed,
    edit_accept_count: cm.edit_accept_count,
    edit_reject_count: cm.edit_reject_count,
    friction_index: cm.friction_index,
    active_time_user_s: cm.active_time_user_s,
    active_time_cli_s: cm.active_time_cli_s,
  };

  const metricsRows = await client
    .select(metricsCols)
    .from(cm)
    .where(and(eq(cm.scope_type, 'organisation'), eq(cm.scope_id, ORG_SCOPE_ID), eq(cm.granularity, 'rolling')))
    .orderBy(desc(cm.computed_at))
    .limit(1);
  const row = metricsRows[0] ?? null;

  const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  const engagedHours = row ? computeEngagedHours(n(row.active_time_user_s), n(row.active_time_cli_s)) : null;

  const signals: CodeSignals = {
    spendUsd: n(row?.spend_usd),
    autonomyRatio: n(row?.autonomy_ratio),
    commitCount: n(row?.commit_count),
    prCount: n(row?.pr_count),
    linesAdded: n(row?.lines_added),
    linesRemoved: n(row?.lines_removed),
    editAcceptCount: n(row?.edit_accept_count),
    editRejectCount: n(row?.edit_reject_count),
    frictionIndex: n(row?.friction_index),
    engagedHours,
    cacheHitRatio: n(row?.cache_hit_ratio),
    hasWorkMix: cfg.codeClassifierEnabled === true,
  };

  const boxes = buildCrosswalk(signals);
  const dx = await getDxFramework();
  const hasData = !!row;

  return NextResponse.json({
    enabled: true,
    hasData,
    boxes,
    spendContext: { spendUsd: signals.spendUsd, autonomyRatio: signals.autonomyRatio },
    dx,
  }, { status: 200 });
}
