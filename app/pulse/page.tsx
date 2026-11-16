// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Redirect: admin, manager and viewer → Overview (/pulse/cio), as in the menu; code → My Developer Pulse; everyone else → My Pulse
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { findValidSession } from '@/lib/db/admin-queries';
import { SESSION_COOKIE_NAME, canAccessOrgOverview } from '@/lib/auth/admin-auth';
import type { UserRole } from '@/lib/auth/admin-auth';

export default async function PulseIndexPage() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (sessionId) {
    const session = await findValidSession(sessionId);
    if (canAccessOrgOverview(session?.user?.role as UserRole | undefined)) {
      redirect('/pulse/cio');
    }
    // The code role has Developer Pulse only, so its own page is there.
    if (session?.user?.role === 'code') redirect('/pulse/code/me');
  }

  redirect('/pulse/me');
}
