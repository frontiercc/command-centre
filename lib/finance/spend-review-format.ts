// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Client-safe formatting shared by the Spend Review page and the report section.

/** How far a cost ratio sits from colleagues, e.g. "0.2%" or "58%": one decimal place under 10%,
 *  so a small gap is shown as it is rather than rounded to 0%. */
export function gapPct(ratio: number): string {
  const gap = Math.round(Math.abs(1 - ratio) * 1000) / 10; // one decimal place
  if (gap >= 10) return `${Math.round(gap)}%`;
  if (gap < 0.1) return 'under 0.1%';
  return `${gap.toFixed(1)}%`;
}

/** "1 Oct": day and short month, as the Spend Review pages show dates. */
export function ukDate(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const d = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** True when a stretch of work starts and ends on different days, as the page shows dates. */
export function spansDays(from: number | null, to: number | null): boolean {
  return from !== null && to !== null && ukDate(from) !== ukDate(to);
}

/** Active time in words: "18 hours", "1 hour", "45 minutes". */
export function workTime(secs: number): string {
  if (secs < 3600) {
    const m = Math.max(1, Math.round(secs / 60));
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  const h = Math.round(secs / 3600);
  return `${h} hour${h === 1 ? '' : 's'}`;
}

/**
 * How much work a kind of work's sessions were: "1 session running 24 Sept to 1 Oct, 18 hours of work",
 * "3 sessions, 4 hours of work", or just "2 sessions" under an hour. A session open for days reads as
 * the stretch of work it was rather than "1 session".
 */
export function sessionsFact(w: { sessions: number; activeSecs: number | null; firstAt: number | null; lastAt: number | null }): string {
  const count = `${w.sessions} session${w.sessions === 1 ? '' : 's'}`;
  const work = w.activeSecs !== null && w.activeSecs >= 3600 ? `${workTime(w.activeSecs)} of work` : null;
  if (w.sessions === 1 && spansDays(w.firstAt, w.lastAt)) {
    return `${count} running ${ukDate(w.firstAt)} to ${ukDate(w.lastAt)}${work ? `, ${work}` : ''}`;
  }
  return work ? `${count}, ${work}` : count;
}
