// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The "did it work" note under a coaching action, shared by Work Pulse and Developer Pulse: when
// it was marked done, what the figure was then, what it is now, and whether that counts as better
// once the check date has passed. One copy, so both surfaces word it the same way.
'use client';

import type { PlanAction } from '@/lib/pulse/coaching-core';

const pct = (v: number | null) => (v === null ? 'not measured' : `${Math.round(v * 100)}%`);
const day = (s: number) => new Date(s * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export const RESULT_WORDS: Record<string, string> = {
  better: 'Moved the right way',
  worse: 'Moved the wrong way',
  same: 'No change yet',
  too_few: 'Too few people to tell',
};
export const RESULT_INK: Record<string, string> = {
  better: '#1A7F37', worse: '#B54708', same: '#666666', too_few: '#8F8F8F',
};

export default function CoachingDone({ a }: { a: PlanAction }) {
  const d = a.done;
  if (!d) return null;
  const waiting = d.result === null;
  return (
    <div className="mt-1.5 pl-3 border-l-2 border-[#EAEAEA] text-[12px] text-[#666666]">
      <p className="m-0">
        Marked done {day(d.at)} by {d.by}
        {d.note ? <> &middot; &ldquo;{d.note}&rdquo;</> : null}
      </p>
      {d.measure && (
        <p className="m-0 mt-0.5">
          {d.measure}: {pct(d.before)} then
          {waiting
            ? <>, checked again from {day(d.checkFrom)}</>
            : <>, {pct(d.now)} now{d.orgBefore !== null && d.orgNow !== null ? <> (organisation {pct(d.orgBefore)} to {pct(d.orgNow)})</> : null}</>}
        </p>
      )}
      {d.result && (
        <p className="m-0 mt-0.5 font-medium" style={{ color: RESULT_INK[d.result] }}>{RESULT_WORDS[d.result]}</p>
      )}
      {d.sharedWith.length > 0 && (
        <p className="m-0 mt-0.5">Other actions aiming at the same figure were done around the same time, so the change can&apos;t be put down to this one alone.</p>
      )}
    </div>
  );
}
