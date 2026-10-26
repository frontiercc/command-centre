// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';
//
// Page-level guard for the core platform pages (Dashboard, Audit Log, Alerts,
// Reports). The sidebar already hides them from contributor roles; this sends
// a contributor who types the address to their own Pulse page instead of
// showing an empty shell. The real gate is server-side in each API route —
// this only keeps the page itself from opening.
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

const CORE_ROLES = new Set(['admin', 'manager', 'viewer']);

export function useCorePlatformGuard(opts: { auditLog?: boolean } = {}): void {
  const router = useRouter();
  const auditLog = opts.auditLog === true;
  useEffect(() => {
    fetch('/api/admin/session')
      .then(r => r.json())
      .then(data => {
        if (!data?.authenticated) return; // middleware handles the login redirect
        const role: string = data.user?.role ?? '';
        // The Audit Log shows prompt text — admin and manager only; a viewer
        // goes to the Dashboard instead.
        if (auditLog && role === 'viewer') { router.replace('/'); return; }
        if (CORE_ROLES.has(role)) return;
        router.replace(role === 'code' ? '/pulse/code/me' : '/pulse/me');
      })
      .catch(() => {});
  }, [router, auditLog]);
}
