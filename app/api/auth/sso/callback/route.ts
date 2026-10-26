// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// GET /api/auth/sso/callback — the IdP redirects here with `code` + `state`.
// completeSsoLogin() does all the cryptographic/authorization work; this
// route's job is purely the HTTP shell around it: mint the same session the
// password login issues (TOTP skipped — IdP-trusted MFA per spec), audit
// every outcome via logAccess, and ALWAYS clear the ccc_sso_pending cookie
// regardless of outcome.
//
// BINDING: the
// pending cookie is a bearer secret good for its whole 10-minute TTL — it is
// not single-use at the crypto layer (unsealPendingPayload doesn't burn it).
// The route layer must make it single-use in effect by clearing it on every
// exit path: success AND every refusal. `clearPendingCookie` below is called
// on all four return points so this can't regress by someone adding a new
// early return later without also clearing the cookie.
import { NextRequest, NextResponse } from 'next/server';
import { getOidcSettings, completeSsoLogin, SSO_PENDING_COOKIE, type SsoRefusal } from '@/lib/auth/oidc';
import { mintSession } from '@/lib/auth/session-mint';
import { logAccess } from '@/lib/audit/log';
import { findAdminById } from '@/lib/db/admin-queries';

export const dynamic = 'force-dynamic';

function clearPendingCookie(response: NextResponse): void {
  response.cookies.set(SSO_PENDING_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
}

export async function GET(request: NextRequest) {
  const settings = await getOidcSettings();
  if (!settings) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Public origin comes from the configured redirect base, NOT `request.url`.
  // Behind a reverse proxy (Caddy → hub:3000) the request's own host is the
  // container's internal bind — e.g. `http://0.0.0.0:3000` — which breaks two
  // things: (1) openid-client's token exchange derives a `redirect_uri` from
  // the callback URL, and an internal-host redirect_uri won't match the public
  // one registered with the IdP → `token_invalid`; (2) the browser-facing
  // redirects below would point at `http://0.0.0.0:3000/...` → ERR_ADDRESS_INVALID.
  // `settings.redirectUri` is the public `<ssoRedirectBaseUrl>/api/auth/sso/callback`.
  const publicCallback = new URL(settings.redirectUri);
  const publicOrigin = publicCallback.origin;

  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    undefined;
  const userAgent = request.headers.get('user-agent') || undefined;

  const pendingCookie = request.cookies.get(SSO_PENDING_COOKIE)?.value;
  // completeSsoLogin (and openid-client's authorizationCodeGrant underneath
  // it) requires a real `URL` instance — `request.nextUrl` is Next.js's
  // `NextURL` wrapper class, which does NOT extend `URL`. Rebuild a plain URL
  // on the PUBLIC origin, carrying the incoming `code`/`state` query so the
  // token-exchange redirect_uri matches what the IdP has registered.
  const callbackUrl = new URL(publicCallback.pathname + new URL(request.url).search, publicOrigin);
  const result = await completeSsoLogin(callbackUrl, pendingCookie);

  if (!result.ok) {
    await logAccess({
      // Pre-auth refusal: there is no authenticated actor yet, so actor
      // fields follow the same "best effort, never fabricated" precedent as
      // the password login route's failure logging (logAuthEvent there logs
      // the attempted email, not a real actor id) — 'anonymous' + email
      // unknown here since an SSO refusal may occur before any email claim
      // is even readable (e.g. state_mismatch).
      actorId: 'anonymous',
      actorEmail: 'unknown',
      actorIp: ip,
      resource: 'auth',
      action: 'SSO_LOGIN',
      outcome: 'failure',
      detail: result.reason,
    });

    const redirectUrl = new URL('/admin/login', publicOrigin);
    redirectUrl.searchParams.set('sso_error', result.reason satisfies SsoRefusal);
    const response = NextResponse.redirect(redirectUrl, { status: 302 });
    clearPendingCookie(response);
    return response;
  }

  const { account } = result;
  // completeSsoLogin()'s SsoResult only carries {id, email, role} — re-fetch
  // the full row so mintSession gets the real display_name rather than a
  // fabricated stand-in. The row is guaranteed to exist: completeSsoLogin
  // just looked it up by email to produce `account` in the first place.
  const user = (await findAdminById(account.id))!;

  // The SSO callback is a full-page browser navigation (not password
  // login's JSON API), so it redirects to '/' rather than returning a JSON
  // body — mintSession decorates this redirect with the session cookie
  // instead of building its own default JSON response.
  const response = await mintSession({
    user,
    rememberMe: false,
    ipAddress: ip,
    userAgent,
    response: NextResponse.redirect(new URL('/', publicOrigin), { status: 302 }),
  });

  await logAccess({
    actorId: account.id,
    actorEmail: account.email,
    actorIp: ip,
    resource: 'auth',
    action: 'SSO_LOGIN',
    outcome: 'success',
  });

  clearPendingCookie(response);

  return response;
}
