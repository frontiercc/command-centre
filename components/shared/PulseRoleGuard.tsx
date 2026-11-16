// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useSessionRole } from '@/components/shared/useSessionRole';
import { pulsePageRedirect } from '@/lib/nav/pulse-pages';

/** Sends someone who opens a Pulse page outside their menu to their own page. Renders nothing. */
export function PulseRoleGuard() {
  const role = useSessionRole();
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => {
    const to = pulsePageRedirect(role, pathname);
    if (to) router.replace(to);
  }, [role, pathname, router]);
  return null;
}
