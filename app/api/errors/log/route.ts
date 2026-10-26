// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { OPEN_ROUTE_BODY_LIMIT, readJsonLimited } from '@/lib/api/body';
import { insertErrorEvents } from '@/lib/db/error-queries';
import { isRateLimited } from '@/lib/auth/rate-limit';

export const dynamic = 'force-dynamic';

// Intentionally unauthenticated — accepts browser error-boundary reports.
// Single-event only (no bulk). Rate-limited per IP to prevent log flooding.
export async function POST(request: NextRequest) {
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown';

  if (isRateLimited(`errors_log:${ip}`, 20, 60000)) {
    return NextResponse.json({ error: 'Rate limited' }, { status: 429 });
  }

  try {
    const body = (await readJsonLimited(request, OPEN_ROUTE_BODY_LIMIT)).value;
    if (!body.message || typeof body.message !== 'string') {
      return NextResponse.json({ error: 'message required' }, { status: 400 });
    }

    await insertErrorEvents([{
      severity: body.severity === 'crash' ? 'crash' : 'error',
      source: 'dashboard',
      message: body.message.slice(0, 2000),
      stack_trace: typeof body.stack_trace === 'string' ? body.stack_trace.slice(0, 5000) : null,
      context_json: typeof body.context_json === 'string' ? body.context_json.slice(0, 2000) : null,
    }]);

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Failed to log error' }, { status: 500 });
  }
}
