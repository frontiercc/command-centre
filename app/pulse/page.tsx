// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Redirect: viewer → /pulse/me, admin → /pulse/cio
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { findValidSession } from '@/lib/db/admin-queries';
import { SESSION_COOKIE_NAME } from '@/lib/auth/admin-auth';

export default async function PulseIndexPage() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (sessionId) {
    const session = await findValidSession(sessionId);
    if (session?.user?.role === 'admin') {
      redirect('/pulse/cio');
    }
  }

  redirect('/pulse/me');
}
