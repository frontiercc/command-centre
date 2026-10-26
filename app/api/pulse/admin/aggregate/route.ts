// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Admin-only endpoint to trigger the pulse aggregation job on demand.
// Used for testing and manual refresh. Not for production use.
import { NextRequest, NextResponse } from 'next/server';
import { getAdminSession } from '@/lib/auth/admin-auth';
import { runHourlyAggregation, runDailyAggregation } from '@/lib/pulse/aggregator';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated || session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const start = Date.now();
  await runHourlyAggregation();
  await runDailyAggregation();
  const elapsed = Date.now() - start;

  return NextResponse.json({ ok: true, elapsed_ms: elapsed });
}
