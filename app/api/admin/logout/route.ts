// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE_NAME, clearSessionCookie } from '@/lib/auth/admin-auth';
import { deleteSessionByToken } from '@/lib/db/admin-queries';
import { logAuthEvent } from '@/lib/db/auth-events';

export async function POST(request: NextRequest) {
  const sessionId = request.cookies.get(SESSION_COOKIE_NAME)?.value;

  if (sessionId) {
    await deleteSessionByToken(sessionId);
  }

  const ip =
    request.headers.get('x-forwarded-for') ||
    request.headers.get('x-real-ip') ||
    undefined;

  await logAuthEvent({
    eventType: 'admin_logout',
    ipAddress: ip ?? null,
  });

  const response = NextResponse.json({ success: true });
  clearSessionCookie(response);

  return response;
}
