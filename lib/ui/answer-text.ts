// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Words for answer sentences. The answer at the top of a panel is written here, in code, from
 * the figures: never by the AI. Client-safe, no imports.
 */

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-GB');
}

export function fmtUsd(n: number, opts: { cents?: boolean } = {}): string {
  const abs = Math.abs(n);
  if (opts.cents || abs < 10) return `$${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${Math.round(n).toLocaleString('en-GB')}`;
}

/** Short money for chart labels: $950, $4.2k, $27k. */
export function fmtUsdShort(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 10000) return `$${Math.round(n / 1000)}k`;
  if (abs >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

export function fmtPct(share: number, digits = 0): string {
  return `${(share * 100).toFixed(digits)}%`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${fmtInt(n)} ${n === 1 ? one : many}`;
}

/** "12% more than", "8% less than", "about the same as". Null when there's nothing to compare. */
export function changeWords(current: number, previous: number | null | undefined, more = 'more', less = 'less'): string | null {
  if (previous == null || previous <= 0) return null;
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return 'about the same as';
  return pct > 0 ? `${pct}% ${more} than` : `${Math.abs(pct)}% ${less} than`;
}

/** "9 more than", "3 fewer than", "the same as" for counts of people or things. */
export function countChangeWords(current: number, previous: number | null | undefined): string | null {
  if (previous == null) return null;
  const d = Math.round(current - previous);
  if (d === 0) return 'the same as';
  return d > 0 ? `${fmtInt(d)} more than` : `${fmtInt(-d)} fewer than`;
}

/** "up from 31%", "down from 44%", "the same as before". Shares as 0 to 1. */
export function shareChangeWords(current: number, previous: number | null | undefined): string | null {
  if (previous == null) return null;
  const a = Math.round(current * 100), b = Math.round(previous * 100);
  if (a === b) return `the same as the ${fmtPct(previous)} before`;
  return a > b ? `up from ${fmtPct(previous)}` : `down from ${fmtPct(previous)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "9 Nov" from epoch seconds, UTC. */
export function dayMonth(epochS: number): string {
  const d = new Date(epochS * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "Nov" or "November" for a YYYY-MM period or epoch seconds. */
export function monthName(p: string | number, long = false): string {
  const m = typeof p === 'string' ? Number(p.slice(5, 7)) - 1 : new Date(p * 1000).getUTCMonth();
  return (long ? MONTHS_LONG : MONTHS)[m] ?? '';
}

/** "3 days", "5 hours", "a few minutes" since epoch seconds. */
export function ageWords(epochS: number, nowS = Math.floor(Date.now() / 1000)): string {
  const s = Math.max(0, nowS - epochS);
  if (s < 3600) return 'under an hour';
  if (s < 86400) return plural(Math.floor(s / 3600), 'hour');
  return plural(Math.floor(s / 86400), 'day');
}

/** A list in words: "Legal", "Legal and Operations", "Legal, Sales and Operations". */
export function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
