// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// "Coaching" — deterministic manager coaching prompts.
// Max 3; every fact traces to stored rows; wording is
// about the work, never performance. Renders nothing when there was never
// anything to coach.
//
// Each row can be marked done — the acknowledgement
// is persisted via POST /api/pulse/coaching/ack and clears the pair from
// coaching everywhere (permanently, no expiry) once the 5-second undo window
// lapses. A marked-done row stays visible for those 5 seconds showing
// "Marked done" + an Undo link; Undo calls DELETE and restores the row. Once
// the last row clears, the card shows a brief "All coaching marked done."
// line rather than unmounting. See app/pulse/dept/page.tsx, which no longer
// wraps this component in a separate spacer div for exactly that reason: an
// always-rendered outer wrapper around a component that used to `return
// null` left a stray empty-margin gap.
'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { B, cx } from '@/components/precision/ui';
import { Frame } from '@/components/pulse/WorkPulseOverview';

export interface CoachingPromptItem { userId: string; displayName: string; promptText: string; useCaseId: string; useCaseTitle: string }

const UNDO_WINDOW_MS = 5000;

function rowKey(p: Pick<CoachingPromptItem, 'userId' | 'useCaseId'>): string {
  return `${p.userId}:${p.useCaseId}`;
}

export default function CoachingPrompts({ prompts }: { prompts: CoachingPromptItem[] }) {
  const [items, setItems] = useState(prompts);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [doneKeys, setDoneKeys] = useState<Set<string>>(new Set());
  const [undoFailedKey, setUndoFailedKey] = useState<string | null>(null);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Sync when the parent hands us a fresh list (e.g. a department switch) —
  // any in-flight undo timers belong to the old list, so clear them first.
  useEffect(() => {
    timers.current.forEach(t => clearTimeout(t));
    timers.current.clear();
    setItems(prompts);
    setDoneKeys(new Set());
    setFailedKey(null);
    setUndoFailedKey(null);
  }, [prompts]);

  useEffect(() => () => { timers.current.forEach(t => clearTimeout(t)); }, []);

  // A department with nothing to coach still shows the panel, saying so: every panel on these
  // pages answers its question, and an empty half-width slot reads as a fault. Whether the list
  // was empty from the server or has just been cleared is told apart in the empty state below.

  function finalizeRemoval(key: string) {
    setItems(prev => prev.filter(item => rowKey(item) !== key));
    setDoneKeys(prev => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    timers.current.delete(key);
  }

  const handleMarkDone = async (p: CoachingPromptItem) => {
    const key = rowKey(p);
    setSavingKey(key);
    setFailedKey(null);
    try {
      const res = await fetch('/api/pulse/coaching/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: p.userId, useCaseId: p.useCaseId }),
      });
      if (!res.ok) throw new Error('failed');
      setDoneKeys(prev => new Set(prev).add(key));
      timers.current.set(key, setTimeout(() => finalizeRemoval(key), UNDO_WINDOW_MS));
    } catch {
      setFailedKey(key);
    } finally {
      setSavingKey(null);
    }
  };

  const handleUndo = async (p: CoachingPromptItem) => {
    const key = rowKey(p);
    const timer = timers.current.get(key);
    if (timer) clearTimeout(timer);
    timers.current.delete(key);
    setUndoFailedKey(null);
    try {
      const res = await fetch('/api/pulse/coaching/ack', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: p.userId, useCaseId: p.useCaseId }),
      });
      if (!res.ok) throw new Error('failed');
      setDoneKeys(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    } catch {
      setUndoFailedKey(key);
      // Re-arm the removal timer so a failed undo doesn't strand the row
      // in "Marked done" forever.
      timers.current.set(key, setTimeout(() => finalizeRemoval(key), UNDO_WINDOW_MS));
    }
  };

  if (items.length === 0) {
    return (
      <Frame
        title="Coaching"
        period="Updated weekly"
        answer={prompts.length === 0
          ? <>Nothing to coach: everyone doing a use case&rsquo;s work is using its skill.</>
          : <>All coaching marked done.</>}
        note="Claude looks for people doing a use case's work without its skill."
      />
    );
  }

  const open = items.filter(p => !doneKeys.has(rowKey(p))).length;
  return (
    <Frame
      title="Coaching"
      period="Updated weekly"
      answer={<><b>{open === 1 ? 'One person is' : `${open} people are`}</b> doing a use case&rsquo;s work without its skill. A word from you is usually enough.</>}
      note="Marked done stays done, so the same conversation never comes back."
    >
      <ul className="m-0 p-0 list-none">
        {items.map(p => {
          const key = rowKey(p);
          if (doneKeys.has(key)) {
            return (
              <li key={key} className="py-2 border-b border-[#F2F2F2] last:border-b-0 flex items-center justify-between gap-3">
                <p className="m-0 text-[13px] text-[#8F8F8F]" role="status">
                  Marked done
                  {undoFailedKey === key && <span className="ml-2 text-[#B42318]">Could not undo. Try again.</span>}
                </p>
                <button
                  type="button"
                  onClick={() => handleUndo(p)}
                  className={B.link}
                >
                  Undo
                </button>
              </li>
            );
          }
          return (
            <li key={key} className="py-2 border-b border-[#F2F2F2] last:border-b-0 flex items-start justify-between gap-3">
              <p className="m-0 text-[13px] leading-5 text-[#333333] min-w-0">
                {p.promptText}{' '}
                <Link href={`/use-cases/${encodeURIComponent(p.useCaseId)}`} className="text-[12px] font-medium text-[#1F6F8B] hover:underline">
                  Open &ldquo;{p.useCaseTitle}&rdquo;
                </Link>
                {failedKey === key && <span className="block text-[13px] text-[#B42318] mt-0.5">Could not save. Try again.</span>}
              </p>
              <button
                type="button"
                onClick={() => handleMarkDone(p)}
                disabled={savingKey === key}
                className={cx(B.secondary, 'shrink-0 !py-0.5 !px-2 !text-[12px]')}
              >
                {savingKey === key ? 'Saving…' : 'Mark done'}
              </button>
            </li>
          );
        })}
      </ul>
    </Frame>
  );
}
