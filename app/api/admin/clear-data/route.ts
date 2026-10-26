// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { GENERIC_ERROR_MESSAGE, logError } from '@/lib/api/errors';
import { getAdminSession } from '@/lib/auth/admin-auth';
import { clearAuditAndAlerts } from '@/lib/admin/clear-data';
import { logAuthEvent } from '@/lib/db/auth-events';

export const dynamic = 'force-dynamic';

/**
 * DESTRUCTIVE — wipes the Audit Log view + Alert view data.
 * Admin-only, requires a typed "DELETE" confirmation, and writes an audit-event
 * record of the action (auth_events is preserved by the wipe, so it survives).
 */
export async function POST(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: admin only' }, { status: 403 });
  }

  let body: { confirm?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (body?.confirm !== 'DELETE') {
    return NextResponse.json(
      { error: 'confirmation_required', message: 'Type DELETE to confirm.' },
      { status: 400 }
    );
  }

  try {
    const counts = await clearAuditAndAlerts();
    const total = Object.values(counts).reduce((a, b) => a + b, 0);

    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      undefined;
    await logAuthEvent({
      eventType: 'audit_alerts_cleared',
      ipAddress: ip,
      details: JSON.stringify({ by: session.email ?? session.role, total, counts }),
    });

    return NextResponse.json({ ok: true, total, counts });
  } catch (err) {
    // Always return JSON — otherwise the client's res.json() throws "Unexpected end of JSON input".
    logError('clear-data', err);
    return NextResponse.json({ error: 'clear_failed', message: GENERIC_ERROR_MESSAGE }, { status: 500 });
  }
}
