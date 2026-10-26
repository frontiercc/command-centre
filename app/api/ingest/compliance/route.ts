// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { GENERIC_ERROR_MESSAGE, logError, safeComplianceResult } from '@/lib/api/errors';
import { requireAdmin } from '@/lib/auth/admin-auth';
import { runComplianceSyncJob } from '@/lib/compliance/job';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!(await requireAdmin(request))) {
    return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });
  }

  try {
    const result = await runComplianceSyncJob({ force: true });
    return NextResponse.json(safeComplianceResult('api/ingest/compliance', result));
  } catch (err) {
    logError('Compliance Route', err);
    return NextResponse.json(
      { skipped: false, chat: null, activity: null, errors: [GENERIC_ERROR_MESSAGE] },
      { status: 500 }
    );
  }
}
