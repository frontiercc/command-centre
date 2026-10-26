// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/** Calendar-week helpers. Weeks start Monday 00:00 UTC. All values unix seconds. */

const DAY = 86400;
const WEEK = 7 * DAY;

/** Monday 00:00 UTC of the week containing ts. */
export function weekStart(ts: number): number {
  const d = new Date(ts * 1000);
  const dow = d.getUTCDay(); // 0=Sun … 6=Sat
  const daysSinceMonday = (dow + 6) % 7;
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  return midnight - daysSinceMonday * DAY;
}

export function priorWeekStart(ts: number): number {
  return weekStart(ts) - WEEK;
}

/** n Monday-starts ascending, ending with the week containing ts. */
export function weekStarts(ts: number, n: number): number[] {
  const current = weekStart(ts);
  return Array.from({ length: n }, (_, i) => current - (n - 1 - i) * WEEK);
}
