// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Mini bar chart for weekly trend series. No client state, no "use client"
 * needed — purely presentational. Renders one bar per element; null values
 * render as an empty slot (never zero-filled, never invented).
 * The last bar is rendered hollow/dashed when `partialLast` is set, with a
 * "week to date" tooltip — a partial (in-progress) week must never look like
 * a completed one.
 *
 * Zero vs null: a real value of 0 renders as a small solid bar in the normal
 * bar colour (data exists, it's just zero); a null renders as a faint
 * baseline tick (no data at all). The two must never look pixel-identical.
 *
 * Bars are HTML boxes rather than a stretched SVG, so their square tops keep
 * their shape at any panel width.
 */

interface SparklineProps {
  data: Array<number | null>;
  partialLast?: boolean;
  className?: string;
  /** Sky Blue when the underlying metric is AI-judged or an estimate; Dark Blue (measured) otherwise. */
  estimate?: boolean;
  /** aria-label for the chart; defaults to a generic label — callers should pass the card title. */
  label?: string;
  /**
   * Fixed scale ceiling. By default bars normalise to the series' own max,
   * which is right for unbounded counts but dishonest for bounded ratios —
   * a 0.10→0.12 drift renders as dramatic growth. Pass the domain max
   * (e.g. 1 for a 0–1 share) so bars are comparable across sparklines.
   */
  fixedMax?: number;
  /** Chart height in px (default 24). */
  height?: number;
}

const ZERO_BAR_HEIGHT = 2;

export default function Sparkline({ data, partialLast = false, className = '', estimate = false, label = 'Weekly trend', fixedMax, height = 24 }: SparklineProps) {
  if (data.length === 0) return null;

  const values = data.filter((v): v is number => v !== null);
  const max = fixedMax ?? (values.length > 0 ? Math.max(...values, 0) : 0);

  const fill = estimate ? '#B4CDFD' : '#05073F';
  const partialFill = estimate ? '#EDF3FF' : '#E8E9F2';
  const partialStroke = estimate ? '#699BFB' : '#05073F';
  const nullTick = estimate ? '#EDF3FF' : '#F2F2F2';
  const gap = height >= 40 ? 4 : 2;

  return (
    <div
      className={`flex items-end w-full ${className}`}
      style={{ height, gap }}
      role="img"
      aria-label={label}
    >
      {data.map((value, i) => {
        const isPartial = partialLast && i === data.length - 1;

        if (value === null) {
          // No data at all — a thin baseline tick, not a bar (never invent data).
          return <div key={i} className="flex-1" style={{ height: 1, background: nullTick }} />;
        }

        // A genuine zero is real data — a short solid bar in the normal colour so it
        // never collides visually with the null tick above. A non-zero value floors at
        // ZERO_BAR_HEIGHT + 1 so "present but small" never reads as less than "none"
        // (with a fixedMax far above the real range a 2% week would otherwise round to
        // 1px and draw SHORTER than a true 0% week).
        const h = value === 0
          ? ZERO_BAR_HEIGHT
          : (max > 0 ? Math.max(ZERO_BAR_HEIGHT + 1, Math.round((value / max) * (height - 2))) : ZERO_BAR_HEIGHT + 1);

        if (isPartial) {
          return (
            <div
              key={i}
              title="week to date"
              className="flex-1 box-border"
              style={{ height: h, background: partialFill, border: `1px dashed ${partialStroke}`, borderRadius: '2px 2px 0 0' }}
            />
          );
        }

        return (
          <div
            key={i}
            className="flex-1"
            style={{ height: h, background: fill, borderRadius: '2px 2px 0 0' }}
          />
        );
      })}
    </div>
  );
}
