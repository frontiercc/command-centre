// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { OPEN_ROUTE_BODY_LIMIT, readJsonLimited } from '@/lib/api/body';
import { isRateLimited } from '@/lib/auth/rate-limit';
import { isAccountLocked, recordFailedLogin, clearFailedLogins } from '@/lib/auth/lockout';
import { verifyPassword } from '@/lib/auth/admin-auth';
import { findAdminByEmail, getTotpStatus } from '@/lib/db/admin-queries';
import { logAuthEvent } from '@/lib/db/auth-events';
import { encryptMfaPending, MFA_PENDING_COOKIE } from '@/lib/auth/totp';
import { mintSession } from '@/lib/auth/session-mint';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown';

  if (isRateLimited('admin_login:' + ip, 5, 60000)) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Too many login attempts. Please try again later.' },
      { status: 429 }
    );
  }

  let body: { email?: string; password?: string; rememberMe?: boolean };
  try {
    body = (await readJsonLimited(request, OPEN_ROUTE_BODY_LIMIT)).value;
  } catch {
    return NextResponse.json(
      { error: 'invalid_body', message: 'Request body must be valid JSON' },
      { status: 400 }
    );
  }

  const { email, password, rememberMe = false } = body;

  if (!email || !password) {
    return NextResponse.json(
      { error: 'missing_fields', message: 'Email and password are required' },
      { status: 400 }
    );
  }

  const userAgent = request.headers.get('user-agent') || undefined;
  const ipAddress = ip !== 'unknown' ? ip : undefined;

  const user = await findAdminByEmail(email);

  // Per-account brute-force lockout (complements the per-IP limit above). A locked
  // account is rejected even with the correct password until the lock auto-expires.
  if (user) {
    const lock = await isAccountLocked(user.id);
    if (lock.locked) {
      await logAuthEvent({ eventType: 'admin_login_locked', ipAddress, details: JSON.stringify({ email }) });
      return NextResponse.json(
        { error: 'rate_limited', message: 'Too many login attempts. Please try again later.' },
        { status: 429 }
      );
    }
  }

  if (!user || !verifyPassword(password, user.password_hash)) {
    if (user) {
      const res = await recordFailedLogin(user.id);
      await logAuthEvent({
        eventType: res.locked ? 'admin_account_locked' : 'admin_login_failed',
        ipAddress,
        details: JSON.stringify({ email }),
      });
      if (res.locked) {
        return NextResponse.json(
          { error: 'rate_limited', message: 'Too many login attempts. Please try again later.' },
          { status: 429 }
        );
      }
    } else {
      await logAuthEvent({ eventType: 'admin_login_failed', ipAddress, details: JSON.stringify({ email }) });
    }
    return NextResponse.json(
      { error: 'invalid_credentials', message: 'Invalid email or password' },
      { status: 401 }
    );
  }

  // Check if MFA is enabled for this user
  const totpStatus = await getTotpStatus(user.id);
  if (totpStatus.enabled) {
    // The failed-attempt count is NOT cleared here: wrong MFA codes count
    // against the same per-account lock (mfa/verify), and clearing it on a
    // correct password would let someone holding the password reset the count
    // between rounds of code guesses. It is cleared once MFA passes.
    // Password correct but MFA required — issue a short-lived pending cookie
    const pendingToken = encryptMfaPending(user.id, rememberMe);
    const response = NextResponse.json({ mfaRequired: true });
    response.cookies.set(MFA_PENDING_COOKIE, pendingToken, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 5 * 60, // 5 minutes
      secure: process.env.NODE_ENV === 'production' && process.env.CCC_INSECURE_COOKIES !== 'true',
    });
    return response;
  }

  // Password correct and no MFA step — clear any failed-login state.
  await clearFailedLogins(user.id);

  // No MFA — issue session directly
  const response = await mintSession({ user, rememberMe, ipAddress, userAgent });

  await logAuthEvent({
    eventType: 'admin_login_success',
    ipAddress,
    details: JSON.stringify({ userId: user.id, email: user.email }),
  });

  return response;
}
