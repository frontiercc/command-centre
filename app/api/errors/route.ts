// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { queryErrorEvents } from '@/lib/db/error-queries';
import { getAdminSession } from '@/lib/auth/admin-auth';

// Disable Next.js route caching — all API routes read live data from the database
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // Error log — admin only (read by the admin system pages).
  if (session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    const url = new URL(request.url);
    const filters = {
      severity: url.searchParams.get('severity') || undefined,
      source: url.searchParams.get('source') || undefined,
      from: url.searchParams.get('from') ? parseInt(url.searchParams.get('from')!, 10) : undefined,
      to: url.searchParams.get('to') ? parseInt(url.searchParams.get('to')!, 10) : undefined,
      limit: url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')!, 10) : undefined,
      offset: url.searchParams.get('offset') ? parseInt(url.searchParams.get('offset')!, 10) : undefined,
    };

    const result = await queryErrorEvents(filters);
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse('Errors API', err);
  }
}
