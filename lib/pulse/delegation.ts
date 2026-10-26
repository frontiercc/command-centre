// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Delegation View — pure builders.
 *
 * Inputs are pulse_metrics WEEKLY rows (granularity='week') reduced to
 * {scopeId, periodStart, t1, t2, t3}. Depth = (t2+t3)/total. Weeks without
 * qualifying data are null (gaps), NEVER 0. Rubric edits make tiers
 * incomparable across the edit (same stance as OTI v1/v2), so series are
 * split into segments at weekStart(changed_at) — the week containing the
 * change starts the NEW segment — and then-vs-now reads the latest segment
 * only. Pure functions; DB reads live in the API routes.
 */
import { weekStart } from '@/lib/pulse/period';

export interface DelegationWeekRow { scopeId: string; periodStart: number; t1: number; t2: number; t3: number }
export interface WeekPoint { weekStart: number; depth: number | null }
export interface DepthSegment { points: WeekPoint[]; startsAtRubricBreak: boolean }
export interface BandWeek { weekStart: number; t1Share: number | null; t2Share: number | null; t3Share: number | null }
export interface BandSegment { weeks: BandWeek[]; startsAtRubricBreak: boolean }
export interface ThenVsNow { then: number; now: number; deltaPp: number; arrow: 'up' | 'flat' | 'down'; dataWeeks: number }

/** A person's week only counts with >= this many classified events; pass 0 to disable (dept/org scopes). */
export const MIN_WEEK_EVENTS = 3;
/** A chart needs >= this many data-weeks in the window, else "building history". */
// 4 → 3: the first real classified history
// reached 3 weeks and the band chart is already a meaningful (if short) read
// at that point; per-person then-vs-now keeps its own stricter minimum.
export const MIN_CHART_DATA_WEEKS = 3;
/** then-vs-now window size k = min(4, floor(n/2)) must be >= this. */
export const THEN_NOW_MIN_K = 2;
/** |delta| in percentage points at or below this renders a flat arrow. */
export const ARROW_THRESHOLD_PP = 5;

function segmentBoundaries(windowWeekStarts: number[], rubricChangesAtS: number[]): Set<number> {
  const inWindow = new Set(windowWeekStarts);
  const bounds = new Set<number>();
  for (const at of rubricChangesAtS) {
    const ws = weekStart(at);
    if (inWindow.has(ws) && ws !== windowWeekStarts[0]) bounds.add(ws);
  }
  return bounds;
}

function splitAtBoundaries<T extends { weekStart: number }>(
  points: T[], bounds: Set<number>,
): Array<{ items: T[]; startsAtRubricBreak: boolean }> {
  const segments: Array<{ items: T[]; startsAtRubricBreak: boolean }> = [];
  let current: T[] = [];
  let startsAtBreak = false;
  for (const p of points) {
    if (bounds.has(p.weekStart) && current.length > 0) {
      segments.push({ items: current, startsAtRubricBreak: startsAtBreak });
      current = [];
      startsAtBreak = true;
    }
    current.push(p);
  }
  if (current.length > 0) segments.push({ items: current, startsAtRubricBreak: startsAtBreak });
  return segments;
}

export function buildDepthSegments(
  rows: DelegationWeekRow[],
  scopeId: string,
  windowWeekStarts: number[],
  rubricChangesAtS: number[],
  minWeekEvents: number = MIN_WEEK_EVENTS,
): DepthSegment[] {
  const byWeek = new Map<number, DelegationWeekRow>();
  for (const r of rows) if (r.scopeId === scopeId) byWeek.set(r.periodStart, r);
  const points: WeekPoint[] = windowWeekStarts.map((ws) => {
    const r = byWeek.get(ws);
    const total = r ? r.t1 + r.t2 + r.t3 : 0;
    if (!r || total === 0 || total < minWeekEvents) return { weekStart: ws, depth: null };
    return { weekStart: ws, depth: (r.t2 + r.t3) / total };
  });
  return splitAtBoundaries(points, segmentBoundaries(windowWeekStarts, rubricChangesAtS))
    .map((s) => ({ points: s.items, startsAtRubricBreak: s.startsAtRubricBreak }));
}

export function buildBandSegments(
  rows: DelegationWeekRow[],
  scopeId: string,
  windowWeekStarts: number[],
  rubricChangesAtS: number[],
): BandSegment[] {
  const byWeek = new Map<number, DelegationWeekRow>();
  for (const r of rows) if (r.scopeId === scopeId) byWeek.set(r.periodStart, r);
  const weeks: BandWeek[] = windowWeekStarts.map((ws) => {
    const r = byWeek.get(ws);
    const total = r ? r.t1 + r.t2 + r.t3 : 0;
    if (!r || total === 0) return { weekStart: ws, t1Share: null, t2Share: null, t3Share: null };
    return { weekStart: ws, t1Share: r.t1 / total, t2Share: r.t2 / total, t3Share: r.t3 / total };
  });
  return splitAtBoundaries(weeks, segmentBoundaries(windowWeekStarts, rubricChangesAtS))
    .map((s) => ({ weeks: s.items, startsAtRubricBreak: s.startsAtRubricBreak }));
}

export function countDataWeeks(segments: DepthSegment[]): number {
  return segments.reduce((n, s) => n + s.points.filter((p) => p.depth !== null).length, 0);
}

/**
 * Data-week count for the LATEST segment only — the same segment
 * buildThenVsNow judges. countDataWeeks() sums across ALL segments, which
 * after a rubric edit contradicts the then-vs-now verdict (e.g. everyone
 * reading "not enough history yet (26w)" when the new segment has 0 weeks).
 * Null-safe: 0 for an empty segments array.
 */
export function countLatestSegmentDataWeeks(segments: DepthSegment[]): number {
  const latest = segments[segments.length - 1];
  if (!latest) return 0;
  return latest.points.filter((p) => p.depth !== null).length;
}

export function buildThenVsNow(segments: DepthSegment[]): ThenVsNow | null {
  const latest = segments[segments.length - 1];
  if (!latest) return null;
  const data = latest.points.filter((p): p is { weekStart: number; depth: number } => p.depth !== null);
  const n = data.length;
  const k = Math.min(4, Math.floor(n / 2));
  if (k < THEN_NOW_MIN_K) return null;
  const mean = (xs: Array<{ depth: number }>) => xs.reduce((s, x) => s + x.depth, 0) / xs.length;
  const then = mean(data.slice(0, k));
  const now = mean(data.slice(n - k));
  const deltaPp = (now - then) * 100;
  const arrow: ThenVsNow['arrow'] = deltaPp > ARROW_THRESHOLD_PP ? 'up' : deltaPp < -ARROW_THRESHOLD_PP ? 'down' : 'flat';
  return { then, now, deltaPp, arrow, dataWeeks: n };
}
