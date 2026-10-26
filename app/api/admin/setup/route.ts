// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { OPEN_ROUTE_BODY_LIMIT, readJsonLimited } from '@/lib/api/body';
import {
  hashPassword,
  getSessionExpiry,
  setSessionCookie,
} from '@/lib/auth/admin-auth';
import {
  adminUserCount,
  createAdminUser,
  createSession,
} from '@/lib/db/admin-queries';
import { logAuthEvent } from '@/lib/db/auth-events';
import { claimSetupToken, restoreSetupToken } from '@/lib/auth/setup-token';
import { MIN_PASSWORD_LENGTH, PASSWORD_TOO_SHORT } from '@/lib/auth/password-policy';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: NextRequest) {
  // Block if setup already completed
  if ((await adminUserCount()) > 0) {
    return NextResponse.json(
      { error: 'setup_complete', message: 'Setup already completed' },
      { status: 409 }
    );
  }

  // Parse JSON body
  let body: { email?: string; password?: string; displayName?: string; setupToken?: string };
  try {
    body = (await readJsonLimited(request, OPEN_ROUTE_BODY_LIMIT)).value;
  } catch {
    return NextResponse.json(
      { error: 'invalid_body', message: 'Request body must be valid JSON' },
      { status: 400 }
    );
  }

  const { email, password, displayName, setupToken } = body;

  // Validate required fields
  if (!email) {
    return NextResponse.json(
      { error: 'missing_field', message: 'Email is required' },
      { status: 400 }
    );
  }

  if (!EMAIL_REGEX.test(email)) {
    return NextResponse.json(
      { error: 'invalid_email', message: 'Invalid email format' },
      { status: 400 }
    );
  }

  if (!password) {
    return NextResponse.json(
      { error: 'missing_field', message: 'Password is required' },
      { status: 400 }
    );
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: 'weak_password', message: PASSWORD_TOO_SHORT },
      { status: 400 }
    );
  }

  // One-time setup token (printed in the server log at boot). Claiming it deletes
  // it in one statement, so only one request can ever get past this point.
  // Checked after validation so a typo in the form does not burn the token.
  const claim = setupToken ? await claimSetupToken(setupToken) : { claimed: false, hash: '' };
  if (!claim.claimed) {
    return NextResponse.json(
      {
        error: 'invalid_setup_token',
        message: 'The setup token is missing or wrong. It is printed in the server log when the hub starts; restart the hub to issue a new one.',
      },
      { status: 403 }
    );
  }
  if ((await adminUserCount()) > 0) {
    return NextResponse.json(
      { error: 'setup_complete', message: 'Setup already completed' },
      { status: 409 }
    );
  }

  const ip =
    request.headers.get('x-forwarded-for') ||
    request.headers.get('x-real-ip') ||
    undefined;
  const userAgent = request.headers.get('user-agent') || undefined;

  // Hash password and create admin user
  const passwordHash = hashPassword(password);
  let user: Awaited<ReturnType<typeof createAdminUser>>;
  try {
    user = await createAdminUser({
      email,
      passwordHash,
      displayName: displayName ?? null,
      role: 'admin',
    });
  } catch (err) {
    // Not the caller's fault: put the token back so setup can be retried.
    await restoreSetupToken(claim.hash).catch(() => {});
    console.error('[Setup] Creating the first admin failed:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'setup_failed', message: 'Setup failed. Please try again.' }, { status: 500 });
  }

  // Create session
  const session = await createSession({
    userId: user.id,
    expiresAt: getSessionExpiry(false),
    ipAddress: ip,
    userAgent,
  });

  // Log auth event
  await logAuthEvent({
    eventType: 'admin_setup',
    ipAddress: ip,
    details: JSON.stringify({ userId: user.id, email: user.email }),
  });

  // Build response and set session cookie
  const response = NextResponse.json(
    {
      success: true,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        role: user.role,
      },
    },
    { status: 201 }
  );

  setSessionCookie(response, session.token, false);

  return response;
}
