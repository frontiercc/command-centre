// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// components/shared/DbStatusBanner.tsx
'use client';

import { useEffect, useState } from 'react';
import { shouldShowBanner } from '@/lib/health/banner-state';

const POLL_MS = 30_000;

export default function DbStatusBanner() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        let status: string | undefined;
        try {
          status = (await res.json())?.status;
        } catch {
          status = undefined;
        }
        if (!cancelled) setShow(shouldShowBanner({ fetchOk: true, status }));
      } catch {
        if (!cancelled) setShow(shouldShowBanner({ fetchOk: false }));
      }
    };

    check();
    const id = setInterval(check, POLL_MS);
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  if (!show) return null;

  return (
    <div
      role="alert"
      className="fixed top-0 inset-x-0 z-[100] bg-red-600 text-white text-sm font-medium text-center px-4 py-2 shadow-md"
    >
      Database unavailable: changes cannot be saved right now. Command Centre will recover automatically when the database is back.
    </div>
  );
}
