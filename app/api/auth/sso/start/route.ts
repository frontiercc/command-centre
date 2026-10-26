// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// GET /api/auth/sso/start — kicks off the OIDC auth-code+PKCE flow. 404s
// (not a redirect) when SSO isn't configured, so an instance with SSO off
// looks like the route doesn't exist at all. Never touches admin_users or
// any session state — beginSsoLogin() only talks to the IdP's discovery
// document and generates the sealed pending payload.
import { NextRequest, NextResponse } from 'next/server';
import { getOidcSettings, beginSsoLogin, SSO_PENDING_COOKIE } from '@/lib/auth/oidc';

export const dynamic = 'force-dynamic';

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the handler signature Next.js calls with
export async function GET(_request: NextRequest) {
  if (!(await getOidcSettings())) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { redirectUrl, pendingCookie } = await beginSsoLogin();

  const response = NextResponse.redirect(redirectUrl, { status: 302 });
  response.cookies.set(SSO_PENDING_COOKIE, pendingCookie, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 600, // 10 minutes — matches the sealed payload's own TTL
    secure: process.env.NODE_ENV === 'production' && process.env.CCC_INSECURE_COOKIES !== 'true',
  });

  return response;
}
