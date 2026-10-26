// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { GENERIC_ERROR_MESSAGE, logError } from '@/lib/api/errors';
import { requireAdmin } from '@/lib/auth/admin-auth';
import { ingestAnalyticsSnapshots } from '@/lib/anthropic/analytics';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!(await requireAdmin(request))) {
    return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });
  }

  try {
    const result = await ingestAnalyticsSnapshots();
    return NextResponse.json(result);
  } catch (err) {
    logError('Analytics Route', err);
    return NextResponse.json(
      { snapshotsUpserted: 0, errors: [GENERIC_ERROR_MESSAGE] },
      { status: 500 }
    );
  }
}
