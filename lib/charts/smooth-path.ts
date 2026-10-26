// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Catmull-Rom → cubic-bezier smoothing for SVG line charts.
// Control-point Y is clamped to the segment's own range so flat runs stay
// flat (no overshoot below a zero baseline) while curves stay wavy.

export interface ChartPoint {
  x: number;
  y: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Smooth open path through the points. 1 point → a dot (with round linecap); 2 points → straight line. */
export function smoothPath(pts: ChartPoint[]): string {
  if (pts.length === 0) return '';
  const f = (v: number) => v.toFixed(1);
  if (pts.length === 1) return `M ${f(pts[0].x)} ${f(pts[0].y)} L ${f(pts[0].x)} ${f(pts[0].y)}`;

  let d = `M ${f(pts[0].x)} ${f(pts[0].y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? pts[i + 1];
    const yLo = Math.min(p1.y, p2.y);
    const yHi = Math.max(p1.y, p2.y);
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = clamp(p1.y + (p2.y - p0.y) / 6, yLo, yHi);
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = clamp(p2.y - (p3.y - p1.y) / 6, yLo, yHi);
    d += ` C ${f(c1x)} ${f(c1y)}, ${f(c2x)} ${f(c2y)}, ${f(p2.x)} ${f(p2.y)}`;
  }
  return d;
}

/** Smooth path closed down to a horizontal baseline — for soft area fills under a wavy line. */
export function smoothAreaPath(pts: ChartPoint[], baselineY: number): string {
  if (pts.length === 0) return '';
  const f = (v: number) => v.toFixed(1);
  const top = smoothPath(pts);
  return `M ${f(pts[0].x)} ${f(baselineY)} L ${top.slice(2)} L ${f(pts[pts.length - 1].x)} ${f(baselineY)} Z`;
}
