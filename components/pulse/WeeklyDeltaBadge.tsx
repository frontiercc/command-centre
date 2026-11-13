// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Honest delta badge: reads "vs last completed week (Mon–Sun)" and only ever
 * compares two completed weeks — the in-progress week is never included.
 * Shared across Developer Pulse (Overview + My Developer Pulse) and the Work Pulse
 * CIO view — previously copy-pasted identically in all three.
 */

interface WeeklyDeltaBadgeProps {
  pct: number | null;
}

export default function WeeklyDeltaBadge({ pct }: WeeklyDeltaBadgeProps) {
  if (pct == null) return <span className="text-[13px] text-[#8F8F8F]">Not enough completed weeks yet</span>;
  const abs = Math.round(Math.abs(pct) * 100);
  if (abs < 1) return <span className="text-[13px] text-[#8F8F8F]">No change on last completed week (Mon–Sun)</span>;
  const sign = pct > 0 ? '↑' : '↓';
  const colour = pct > 0 ? 'text-[#1A7F37]' : 'text-[#B42318]';
  return (
    <span className={`text-[13px] tabular-nums ${colour}`}>
      {sign} {abs}% on last completed week (Mon–Sun)
    </span>
  );
}
