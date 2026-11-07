// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Where to send someone after they sign in. Client-safe, no imports.
 *
 * Only a path inside this app is accepted: it must start with a single '/',
 * and anything that could leave the site (`//host`, a backslash, a scheme) is
 * refused, as are the sign-in pages themselves, so a crafted `from` can never
 * become an open redirect or a loop.
 */
const AUTH_PAGES = ['/admin/login', '/admin/setup', '/admin/forgot-password', '/admin/reset-password'];

export const DEFAULT_AFTER_SIGN_IN = '/admin/overview';

export function safeReturnPath(from: string | null | undefined): string | null {
  if (!from || typeof from !== 'string') return null;
  if (!from.startsWith('/') || from.startsWith('//')) return null;
  if (from.includes('\\') || from.includes('://')) return null;
  if (/[\u0000-\u001f]/.test(from)) return null;
  const path = from.split(/[?#]/)[0];
  if (AUTH_PAGES.some(p => path === p || path.startsWith(`${p}/`))) return null;
  return from;
}

export function getSafeRedirect(from: string | null | undefined): string {
  return safeReturnPath(from) ?? DEFAULT_AFTER_SIGN_IN;
}

/** True on the pages someone uses to sign in, where no session is expected. */
export function isAuthPage(pathname: string): boolean {
  return AUTH_PAGES.some(p => pathname === p || pathname.startsWith(`${p}/`));
}

/** sessionStorage key carrying the return path across an SSO round trip. */
export const RETURN_TO_KEY = 'ccc:returnTo';
