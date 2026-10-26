// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { getDbStats } from '@/lib/db/queries';
import { getAllConfig } from '@/lib/config';
import { getAdminSession } from '@/lib/auth/admin-auth';

// Disable Next.js route caching — all API routes read live data from the database
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // Database statistics — admin only (admin overview/system pages).
  if (session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    const stats = await getDbStats();
    const config = await getAllConfig();

    return NextResponse.json({
      ...stats,
      retentionLastRun: config.retentionLastRun || null,
      retentionLastResult: config.retentionLastResult ? JSON.parse(config.retentionLastResult) : null,
    });
  } catch (err) {
    return errorResponse('api/db/stats', err);
  }
}
