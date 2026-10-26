// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Shared "issue a full session" step — the exact success-branch logic that
// used to live only in app/api/admin/login/route.ts's no-MFA path. Moved
// (not forked) here so the OIDC SSO callback (app/api/auth/sso/callback/route.ts)
// can mint an IDENTICAL session/cookie/bookkeeping sequence without
// duplicating it. Password login's behaviour is byte-identical after this
// move — it now just calls this helper instead of inlining the steps.
//
// Deliberately does NOT touch TOTP: MFA is a pre-condition decided by each
// caller (password login checks it and branches to the MFA-pending cookie
// before ever reaching this helper; SSO skips it entirely per spec — IdP-
// trusted MFA). This helper only ever represents "auth is fully satisfied,
// issue the session now."
import { NextResponse } from 'next/server';
import { createSession, updateAdminLastLogin, type AdminUserRow } from '@/lib/db/admin-queries';
import { getSessionExpiry, setSessionCookie } from '@/lib/auth/admin-auth';

export interface MintSessionParams {
  user: Pick<AdminUserRow, 'id' | 'email' | 'display_name' | 'role'>;
  rememberMe: boolean;
  ipAddress?: string;
  userAgent?: string;
  /**
   * Optional pre-built response to decorate with the session cookie instead
   * of the default `{ success: true, user }` JSON body. The SSO callback
   * uses this to mint onto a 302 redirect rather than password login's JSON
   * API contract, without duplicating any cookie-setting logic.
   */
  response?: NextResponse;
}

/**
 * Creates the session row, bumps last_login_at, and returns a response with
 * the session cookie already set. Defaults to the same JSON shape password
 * login has always returned (`{ success: true, user: {...} }`); pass
 * `response` to decorate a different response (e.g. a redirect) instead.
 */
export async function mintSession({ user, rememberMe, ipAddress, userAgent, response }: MintSessionParams): Promise<NextResponse> {
  const session = await createSession({
    userId: user.id,
    expiresAt: getSessionExpiry(rememberMe),
    ipAddress,
    userAgent,
  });

  await updateAdminLastLogin(user.id);

  const res = response ?? NextResponse.json({
    success: true,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
    },
  });

  setSessionCookie(res, session.token, rememberMe);

  return res;
}
