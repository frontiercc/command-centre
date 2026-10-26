// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { errorResponse, logError } from '@/lib/api/errors';
import { runRetentionCleanup } from '@/lib/retention/cleanup';
import { requireAdmin } from '@/lib/auth/admin-auth';

export async function POST(request: NextRequest) {
  if (!(await requireAdmin(request))) {
    return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 });
  }
  try {
    const result = await runRetentionCleanup();

    // The archive step's error text stays in the server log.
    if (result.archive_error) logError('Retention API archive', result.archive_error);
    const safe = result.archive_error ? { ...result, archive_error: 'Archive step failed; cleanup did not run. Details are in the server log.' } : result;
    return NextResponse.json(safe);
  } catch (err) {
    return errorResponse('Retention API', err);
  }
}
