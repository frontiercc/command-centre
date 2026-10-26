// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// middleware.ts
import { NextRequest, NextResponse } from 'next/server';
import { bodyLimitFor } from '@/lib/api/body';

const SESSION_COOKIE_NAME = 'ccc_session';

// Routes that never need auth
const PUBLIC_PATHS = ['/admin/login', '/admin/setup', '/admin/forgot-password'];

// Dynamic public path prefixes (e.g. /admin/reset-password/<token>)
const PUBLIC_PREFIXES = ['/admin/reset-password/'];

// API prefixes that skip the session check: token-authenticated (OTel ingest,
// export) or public by design (health, error log, sign-in and SSO routes)
const SELF_AUTH_API_PREFIXES = [
  '/api/otel/',
  '/api/export/',
  '/api/errors/log',
  '/api/health',
  '/api/admin/login',
  '/api/admin/logout',
  '/api/admin/setup',
  '/api/admin/session',
  '/api/admin/forgot-password',
  '/api/admin/reset-password',
  '/api/admin/mfa/verify',
  '/api/auth/sso/',
];

// Cross-site request check. A state-changing
// API request whose Origin names another site is refused. Exempt: callers that
// are never a browser on our pages and carry their own token (OTel ingest,
// export, MCP, health) and the SSO flow.
const ORIGIN_CHECK_EXEMPT_PREFIXES = [
  '/api/otel/',
  '/api/export/',
  '/api/health',
  '/api/auth/sso/',
];
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * True when the request may proceed. A request with no Origin header passes: a
 * browser always sends Origin on a cross-site POST/PUT/PATCH/DELETE, so a missing
 * one means a non-browser client (curl, a script, a collector), which carries no
 * victim's cookies. The Origin must match the host the browser addressed: the
 * Host header, or a proxy's X-Forwarded-Host / X-Original-Host (a gateway may
 * rewrite Host; a cross-site page cannot set these headers without a CORS
 * preflight, which this app never grants).
 */
export function originAllowed(request: NextRequest): boolean {
  if (!STATE_CHANGING_METHODS.has(request.method)) return true;
  const path = request.nextUrl.pathname;
  if (!path.startsWith('/api/')) return true;
  if (path === '/api/mcp' || path.startsWith('/api/mcp/')) return true;
  if (ORIGIN_CHECK_EXEMPT_PREFIXES.some(p => path.startsWith(p))) return true;
  const origin = request.headers.get('origin');
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false; // includes Origin: null (sandboxed frames, some redirects)
  }
  const hosts = ['host', 'x-forwarded-host', 'x-original-host']
    .flatMap(h => (request.headers.get(h) ?? '').split(','))
    .map(h => h.trim().toLowerCase().replace(/:(443|80)$/, '')) // a default port may be spelled out; URL().host drops it
    .filter(Boolean);
  return hosts.includes(originHost);
}

function buildCsp(nonce: string): string {
  const unsafeEval = process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : '';
  return [
    "default-src 'self'",
    // nonce allows Next.js hydration scripts; strict-dynamic trusts scripts they load (code-split chunks)
    // unsafe-eval required in dev mode for Next.js HMR/react-refresh
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${unsafeEval}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Static assets, _next, favicon — skip entirely (CSP on static files is unnecessary).
  // The "has a dot" rule applies only outside /api/: an API path can carry a dot
  // in a dynamic segment (an email, a connector name) and must still get the
  // cross-site, size and session checks below (it used to skip all of them).
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    (!pathname.startsWith('/api/') && pathname.includes('.'))
  ) {
    return NextResponse.next();
  }

  // Generate a per-request nonce. crypto.randomUUID() and Buffer are both available
  // in the Next.js Edge Runtime.
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = buildCsp(nonce);

  // Pass-through: forwards nonce to Next.js (via x-nonce request header so it can
  // nonce its own inline hydration scripts) and sets CSP on the response.
  const passThrough = () => {
    const reqHeaders = new Headers(request.headers);
    reqHeaders.set('x-nonce', nonce);
    const response = NextResponse.next({ request: { headers: reqHeaders } });
    response.headers.set('Content-Security-Policy', csp);
    return response;
  };

  // Cross-site check before anything else, including the public auth routes
  // (a forged cross-site login or setup is refused too).
  if (!originAllowed(request)) {
    return NextResponse.json({ error: 'Cross-site request refused' }, { status: 403 });
  }

  // Declared body size over the route's limit. The
  // route's own reader also stops at the limit, for bodies without a length.
  const bodyLimit = bodyLimitFor(pathname);
  if (bodyLimit !== null && STATE_CHANGING_METHODS.has(request.method)) {
    const declared = Number(request.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > bodyLimit) {
      return NextResponse.json({ error: 'Request body too large' }, { status: 413 });
    }
  }

  // Public pages (login, setup, forgot/reset password)
  if (PUBLIC_PATHS.some(p => pathname === p)) return passThrough();
  if (PUBLIC_PREFIXES.some(p => pathname.startsWith(p))) return passThrough();

  // Token-authenticated and public API routes: skip the session check
  if (SELF_AUTH_API_PREFIXES.some(p => pathname.startsWith(p))) return passThrough();

  // '/api/mcp' matches exactly or '/api/mcp/...' — a plain startsWith('/api/mcp')
  // would also unshield a future '/api/mcp-anything' route.
  if (pathname === '/api/mcp' || pathname.startsWith('/api/mcp/')) return passThrough();

  // Dev bypass: skip auth entirely when explicitly enabled (non-production only)
  if (process.env.CCC_DEV_BYPASS_AUTH === 'true' && process.env.NODE_ENV !== 'production') {
    return passThrough();
  }

  // Session presence check only — full session validation (DB lookup, expiry check)
  // happens in each route handler via getAdminSession(). This middleware gate prevents
  // unauthenticated page access and API calls, but does not replace handler-side validation.
  const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;

  if (!sessionCookie) {
    // API routes return 401 JSON
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    // Page routes redirect to login — browser follows the redirect and gets a fresh nonce
    const loginUrl = new URL('/admin/login', request.url);
    loginUrl.searchParams.set('from', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return passThrough();
}

export const config = {
  // Match all routes except static files
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
