// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

// Sends people to the sign-in page as soon as their session has ended, instead
// of leaving them on a page whose data calls are all refused ("Failed to load
// dashboard data", an empty sidebar). The middleware only checks that a session
// cookie exists; the cookie outlives the session (8-hour idle timeout, SSO
// expiry), so the page itself has to notice.
//
// It asks GET /api/admin/session ("am I still signed in?") when a page opens,
// when the tab comes back into view, and after any of this app's API calls is
// refused with 401. A 401 alone is not taken as signed out, because a few
// routes answer 401 for other reasons (a wrong MFA code, a wrong password when
// switching MFA off). Only "not authenticated" from the session check signs the
// person out: the dead cookie is cleared and they land on sign-in with a note,
// returning to the page they were on afterwards (also across an SSO round trip).
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { isAuthPage, safeReturnPath, RETURN_TO_KEY } from '@/lib/auth/safe-redirect';

let leaving = false;
let checking: Promise<void> | null = null;

function currentPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}

async function checkSession(nativeFetch: typeof fetch): Promise<void> {
  if (leaving || isAuthPage(window.location.pathname)) return;
  if (checking) return checking;
  checking = (async () => {
    try {
      const res = await nativeFetch('/api/admin/session', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (data?.authenticated) {
        // Back from SSO, which always lands on the home page: finish the return trip.
        let back: string | null = null;
        try { back = sessionStorage.getItem(RETURN_TO_KEY); sessionStorage.removeItem(RETURN_TO_KEY); } catch { /* storage off */ }
        const safe = safeReturnPath(back);
        if (safe && safe !== currentPath()) window.location.replace(safe);
        return;
      }
      if (data?.setupNeeded) return;
      leaving = true;
      await nativeFetch('/api/admin/logout', { method: 'POST' }).catch(() => {});
      const url = new URL('/admin/login', window.location.origin);
      const from = safeReturnPath(currentPath());
      if (from) url.searchParams.set('from', from);
      url.searchParams.set('expired', '1');
      window.location.replace(url.toString());
    } catch {
      // Network trouble is not a sign-out: stay put.
    } finally {
      checking = null;
    }
  })();
  return checking;
}

export default function SessionWatch() {
  const pathname = usePathname();

  // Install once: notice refused API calls.
  useEffect(() => {
    const w = window as unknown as { __cccSessionWatch?: boolean };
    if (w.__cccSessionWatch) return;
    w.__cccSessionWatch = true;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const res = await nativeFetch(input, init);
      if (res.status === 401) {
        const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const url = new URL(raw, window.location.origin);
        if (url.origin === window.location.origin && url.pathname.startsWith('/api/') && url.pathname !== '/api/admin/session') {
          void checkSession(nativeFetch);
        }
      }
      return res;
    };
    const onVisible = () => { if (document.visibilityState === 'visible') void checkSession(nativeFetch); };
    document.addEventListener('visibilitychange', onVisible);
    (w as unknown as { __cccNativeFetch?: typeof fetch }).__cccNativeFetch = nativeFetch;
  }, []);

  // Check on every page opened.
  useEffect(() => {
    const nativeFetch = (window as unknown as { __cccNativeFetch?: typeof fetch }).__cccNativeFetch ?? window.fetch.bind(window);
    void checkSession(nativeFetch);
  }, [pathname]);

  return null;
}
