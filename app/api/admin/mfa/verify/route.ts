// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { OPEN_ROUTE_BODY_LIMIT, readJsonLimited } from '@/lib/api/body';
import { isRateLimited } from '@/lib/auth/rate-limit';
import { decryptMfaPending, verifyAndConsumeTotp, hashRecoveryCode, MFA_PENDING_COOKIE } from '@/lib/auth/totp';
import { findAdminById, getTotpStatus, consumeTotpRecoveryCode, createSession, updateAdminLastLogin } from '@/lib/db/admin-queries';
import { getSessionExpiry, setSessionCookie } from '@/lib/auth/admin-auth';
import { logAuthEvent } from '@/lib/db/auth-events';
import { isAccountLocked, recordFailedLogin, clearFailedLogins } from '@/lib/auth/lockout';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown';

  if (isRateLimited('mfa_verify:' + ip, 5, 60000)) {
    return NextResponse.json({ error: 'rate_limited', message: 'Too many attempts. Please try again later.' }, { status: 429 });
  }

  // Decrypt the pending MFA cookie
  const pendingToken = request.cookies.get(MFA_PENDING_COOKIE)?.value;
  if (!pendingToken) {
    return NextResponse.json({ error: 'session_expired', message: 'Login session expired. Please sign in again' }, { status: 401 });
  }

  const pending = decryptMfaPending(pendingToken);
  if (!pending) {
    return NextResponse.json({ error: 'session_expired', message: 'Login session expired. Please sign in again' }, { status: 401 });
  }

  const body = await readJsonLimited(request, OPEN_ROUTE_BODY_LIMIT).then(r => r.value).catch(() => ({}));
  const { code } = body as { code?: string };

  if (!code) {
    return NextResponse.json({ error: 'code_required', message: 'Verification code is required' }, { status: 400 });
  }

  const user = await findAdminById(pending.userId);
  if (!user) {
    return NextResponse.json({ error: 'user_not_found' }, { status: 401 });
  }

  // Per-account limit on code guessing, shared with the password lockout (10
  // failures, then 15 minutes). The per-address limit above keys on a header
  // the caller controls behind a load balancer, so it alone does not stop
  // someone who holds the password.
  const lock = await isAccountLocked(user.id);
  if (lock.locked) {
    await logAuthEvent({ eventType: 'admin_login_locked', ipAddress: ip !== 'unknown' ? ip : undefined, details: JSON.stringify({ email: user.email, step: 'mfa' }) });
    return NextResponse.json({ error: 'rate_limited', message: 'Too many attempts. Please try again later.' }, { status: 429 });
  }

  const totpStatus = await getTotpStatus(pending.userId);
  if (!totpStatus.enabled || !totpStatus.secret) {
    return NextResponse.json({ error: 'mfa_not_enabled' }, { status: 400 });
  }

  // Try TOTP code first, then recovery code
  const cleanCode = code.replace(/\s/g, '');
  const validTotp = await verifyAndConsumeTotp(pending.userId, cleanCode, totpStatus.secret);
  const validRecovery = !validTotp && (await consumeTotpRecoveryCode(pending.userId, hashRecoveryCode(cleanCode)));

  if (!validTotp && !validRecovery) {
    const res = await recordFailedLogin(user.id);
    await logAuthEvent({
      eventType: res.locked ? 'admin_account_locked' : 'mfa_failed',
      ipAddress: ip !== 'unknown' ? ip : undefined,
      details: JSON.stringify({ userId: pending.userId, email: user.email }),
    });
    if (res.locked) {
      return NextResponse.json({ error: 'rate_limited', message: 'Too many attempts. Please try again later.' }, { status: 429 });
    }
    return NextResponse.json({ error: 'invalid_code', message: 'Incorrect code. Please try again' }, { status: 401 });
  }

  await clearFailedLogins(user.id);

  // MFA passed — issue full session
  const session = await createSession({
    userId: user.id,
    expiresAt: getSessionExpiry(pending.rememberMe),
    ipAddress: ip !== 'unknown' ? ip : undefined,
    userAgent: request.headers.get('user-agent') ?? undefined,
  });

  await updateAdminLastLogin(user.id);

  await logAuthEvent({
    eventType: 'admin_login_success',
    ipAddress: ip !== 'unknown' ? ip : undefined,
    details: JSON.stringify({ userId: user.id, email: user.email, mfa: validRecovery ? 'recovery_code' : 'totp' }),
  });

  const response = NextResponse.json({
    success: true,
    user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role },
  });

  setSessionCookie(response, session.token, pending.rememberMe);

  // Clear the pending MFA cookie
  response.cookies.set(MFA_PENDING_COOKIE, '', { httpOnly: true, maxAge: 0, path: '/' });

  return response;
}
