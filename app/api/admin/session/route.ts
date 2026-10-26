// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { getAdminSession, isSetupNeeded, clearSessionCookie, SESSION_COOKIE_NAME } from '@/lib/auth/admin-auth';
import { getTotpStatus } from '@/lib/db/admin-queries';

// Disable Next.js route caching — all API routes read live data from the database
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  // Check if setup is needed first
  if (await isSetupNeeded()) {
    return signedOut(request, NextResponse.json({ authenticated: false, setupNeeded: true }));
  }

  // Check for valid session
  const session = await getAdminSession(request);

  if (session.authenticated) {
    const { enabled: totpEnabled } = await getTotpStatus(session.userId!);
    return NextResponse.json({
      authenticated: true,
      user: {
        id: session.userId,
        email: session.email,
        displayName: session.displayName,
        role: session.role,
        department: session.department ?? null,
        totpEnabled,
      },
    });
  }

  return signedOut(request, NextResponse.json({ authenticated: false }));
}

// A browser can keep a session cookie that no longer matches a session, for
// example after the database was deleted with `docker compose down -v`. Clear
// it, so the next page load goes to sign-in (or setup) instead of failing.
function signedOut(request: NextRequest, response: NextResponse): NextResponse {
  if (request.cookies.get(SESSION_COOKIE_NAME)) clearSessionCookie(response);
  return response;
}
