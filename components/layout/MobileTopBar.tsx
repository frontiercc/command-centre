// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0
// Some icon drawings in this file are from Heroicons (MIT); see THIRD-PARTY-NOTICES.md.

'use client';

import { useEffect, useState } from 'react';
import { logoFor, type Theme } from '@/lib/theme';

function initialsOf(name: string, email: string): string {
  const src = name.trim() || email.trim();
  if (!src) return '';
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

export default function MobileTopBar({ theme = 'default' }: { theme?: Theme }) {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    fetch('/api/admin/session')
      .then(r => r.json())
      .then(data => {
        if (data.authenticated) {
          setAuthed(true);
          setDisplayName(data.user?.displayName ?? '');
          setEmail(data.user?.email ?? '');
        }
      })
      .catch(() => {});
  }, []);

  const initials = initialsOf(displayName, email);

  return (
    <header className="ccc-mobile-top lg:hidden sticky top-0 z-20 bg-sidebar-bg flex items-center gap-3 px-4 py-3">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={logoFor(theme)} alt="Frontier Command Centre" className="h-6 w-auto" />
      <span className="text-gray-400 text-sm font-light">Command Centre</span>
      {authed && (
        <span className="ml-auto flex items-center gap-2">
          {initials && (
            <span
              className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-brand text-white text-xs font-semibold"
              title={displayName || email}
            >
              {initials}
            </span>
          )}
          <button
            onClick={async () => {
              try { sessionStorage.removeItem('ccc-nav-cache'); } catch { /* storage unavailable */ }
              await fetch('/api/admin/logout', { method: 'POST' });
              window.location.href = '/login';
            }}
            aria-label="Logout"
            className="p-1.5 text-gray-400 hover:text-white transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
            </svg>
          </button>
        </span>
      )}
    </header>
  );
}
