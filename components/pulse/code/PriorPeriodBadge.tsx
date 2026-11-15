// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Developer Pulse's change badge: the last 30 days against the 30 days before,
 * from the aggregator's 'rolling' and 'rolling_prior' rows. Null when there is
 * no figure for the 30 days before (nothing happened then, or it was nil), so a
 * change is never worked out against nothing.
 */

/** The change from `before` to `now` as a fraction, or null when it cannot be worked out. */
export function priorPeriodChange(now: number | null | undefined, before: number | null | undefined): number | null {
  if (now == null || before == null || before === 0) return null;
  return (now - before) / before;
}

export default function PriorPeriodBadge({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-[13px] text-[#8F8F8F]">Nothing in the 30 days before to compare with</span>;
  const abs = Math.round(Math.abs(pct) * 100);
  if (abs < 1) return <span className="text-[13px] text-[#8F8F8F]">No change on the 30 days before</span>;
  const sign = pct > 0 ? '↑' : '↓';
  const colour = pct > 0 ? 'text-[#1A7F37]' : 'text-[#B42318]';
  return (
    <span className={`text-[13px] tabular-nums ${colour}`}>
      {sign} {abs}% on the 30 days before
    </span>
  );
}
