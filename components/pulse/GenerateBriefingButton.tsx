// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0
// Some icon drawings in this file are from Heroicons (MIT); see THIRD-PARTY-NOTICES.md.

'use client';

import { useState } from 'react';
import { B } from '@/components/precision/ui';

interface GenerateBriefingButtonProps {
  type: 'user' | 'cio' | 'all_users' | 'dept';
  userId?: string;
  dept?: string;
  onComplete?: () => void;
  label?: string;
}

export default function GenerateBriefingButton({
  type,
  userId,
  dept,
  onComplete,
  label,
}: GenerateBriefingButtonProps) {
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const defaultLabel = type === 'all_users' ? 'Generate all briefings' : 'Generate now';

  async function handleClick() {
    setGenerating(true);
    setError(null);
    setDone(false);

    try {
      const res = await fetch('/api/pulse/briefing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, userId, dept }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Couldn't generate the briefing. Try again.");
      }

      setDone(true);
      setTimeout(() => setDone(false), 3000);
      onComplete?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleClick}
        disabled={generating}
        type="button"
        className={B.accent}
      >
        {generating ? (
          <>
            <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Generating...
          </>
        ) : done ? (
          <>
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            Done
          </>
        ) : (
          label ?? defaultLabel
        )}
      </button>
      {error && (
        <span className="text-[13px] text-[#B42318]">{error}</span>
      )}
    </div>
  );
}
