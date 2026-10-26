// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { GENERIC_ERROR_MESSAGE, logError, safeComplianceResult, sanitizeErrors } from '@/lib/api/errors';
import { requireAdmin } from '@/lib/auth/admin-auth';
import { runComplianceSyncJob } from '@/lib/compliance/job';
import { ingestAnalyticsSnapshots } from '@/lib/anthropic/analytics';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!(await requireAdmin(request))) {
    return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });
  }

  const results: Record<string, unknown> = {};

  try {
    const c = await runComplianceSyncJob({ force: true });
    results.compliance = safeComplianceResult('api/ingest/trigger compliance', c);
  } catch (err) {
    logError('api/ingest/trigger compliance', err);
    results.compliance = {
      skipped: false, chat: null, activity: null,
      errors: [GENERIC_ERROR_MESSAGE],
    };
  }

  try {
    const a = await ingestAnalyticsSnapshots();
    results.analytics = { ...a, errors: sanitizeErrors('api/ingest/trigger analytics', a.errors) };
  } catch (err) {
    logError('api/ingest/trigger analytics', err);
    results.analytics = {
      snapshotsUpserted: 0,
      errors: [GENERIC_ERROR_MESSAGE],
    };
  }

  return NextResponse.json({
    triggered_at: new Date().toISOString(),
    results,
  });
}
