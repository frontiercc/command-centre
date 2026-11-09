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
import { hasCodexData, readCodeMetrics } from '@/lib/pulse/code/vendor-view';
import { getAllConfig } from '@/lib/config';
import { buildCrosswalk, computeEngagedHours, type CodeSignals } from '@/lib/pulse/code/framework';
import { getDxFramework } from '@/lib/pulse/code/dx-framework';
import { ORG_SCOPE_ID } from '@/lib/pulse/code/aggregator';
import { visibleVendor, visibleOpenAi } from '@/lib/sources/openai-visibility';

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
  // Developer Pulse's All / Claude / Codex switch (?vendor=), as its other
  // pages: once Codex data exists and is shown, the view's own row in
  // code_metrics_vendor; before then Claude Code's code_metrics row.
  const codexPresent = await visibleOpenAi(hasCodexData());
  const requested = await visibleVendor(request.nextUrl.searchParams.get('vendor'));
  const vendor = codexPresent ? requested : 'claude';
  const metricsRows = await readCodeMetrics(vendor, codexPresent, (t, only) => client
    .select({
      spend_usd: t.spend_usd, autonomy_ratio: t.autonomy_ratio, cache_hit_ratio: t.cache_hit_ratio,
      commit_count: t.commit_count, pr_count: t.pr_count, lines_added: t.lines_added, lines_removed: t.lines_removed,
      edit_accept_count: t.edit_accept_count, edit_reject_count: t.edit_reject_count, friction_index: t.friction_index,
      active_time_user_s: t.active_time_user_s, active_time_cli_s: t.active_time_cli_s,
    })
    .from(t)
    .where(and(eq(t.scope_type, 'organisation'), eq(t.scope_id, ORG_SCOPE_ID), eq(t.granularity, 'rolling'), only))
    .orderBy(desc(t.computed_at))
    .limit(1));
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
    vendor,
  };

  const boxes = buildCrosswalk(signals);
  const dx = await getDxFramework();
  const hasData = !!row;

  return NextResponse.json({
    enabled: true,
    vendor,
    codexPresent,
    hasData,
    boxes,
    spendContext: { spendUsd: signals.spendUsd, autonomyRatio: signals.autonomyRatio },
    dx,
  }, { status: 200 });
}
