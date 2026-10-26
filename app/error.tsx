// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    fetch('/api/errors/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        severity: 'error',
        source: 'dashboard',
        message: error.message,
        stack_trace: error.stack,
        context_json: JSON.stringify({ digest: error.digest, page: typeof window !== 'undefined' ? window.location.pathname : 'unknown' }),
      }),
    }).catch(() => { /* fire-and-forget */ });
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white border border-gray-200 rounded-[12px] p-8 max-w-md text-center">
        <h2 className="text-lg font-semibold text-gray-900 mb-2">Something went wrong</h2>
        <p className="text-sm text-gray-500 mb-4">{error.message}</p>
        <button
          onClick={reset}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-[10px] hover:bg-blue-700"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
