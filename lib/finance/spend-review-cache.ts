// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// In-process cache for Spend Review results. Every page load used to work
// everything out fresh, which grows with the hub. A result is now kept for FRESH_MS (current month) or
// PAST_MONTH_FRESH_MS (a finished month, which barely changes); once older,
// the kept result is served at once and rebuilt in the background
// (stale-while-revalidate), so after the first load nobody waits. One build
// per key at a time; a forced refresh waits for its own build.
//
// Per instance, by design: a hub behind several instances keeps one cache
// each, which costs a duplicate build, never a wrong answer.

export const FRESH_MS = 5 * 60 * 1000;
export const PAST_MONTH_FRESH_MS = 60 * 60 * 1000;
/** Bound on kept results (one per person-month viewed, plus indexes). */
const MAX_ENTRIES = 500;

interface Entry<T> { value: T; computedAt: number; }

const entries = new Map<string, Entry<unknown>>();
const inFlight = new Map<string, Promise<Entry<unknown>>>();

/** Test hook. */
export function clearSpendReviewCache(): void {
  entries.clear();
  inFlight.clear();
}

function build<T>(key: string, fn: () => Promise<T>, now: () => number): Promise<Entry<T>> {
  const running = inFlight.get(key) as Promise<Entry<T>> | undefined;
  if (running) return running;
  const p = fn()
    .then(value => {
      const entry: Entry<T> = { value, computedAt: now() };
      entries.delete(key); // re-insert so Map order is least-recently-built first
      entries.set(key, entry);
      while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
      return entry;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p as Promise<Entry<unknown>>);
  return p;
}

/**
 * The cached value for `key`, building it when absent (or when `force`).
 * A stale value is returned immediately and rebuilt in the background; a
 * background failure keeps the last good value (logged by the caller's fn).
 */
export async function cached<T>(
  key: string,
  freshMs: number,
  fn: () => Promise<T>,
  opts: { force?: boolean; now?: () => number } = {},
): Promise<{ value: T; computedAt: number; stale: boolean }> {
  const now = opts.now ?? Date.now;
  const hit = entries.get(key) as Entry<T> | undefined;
  if (hit && !opts.force) {
    const stale = now() - hit.computedAt >= freshMs;
    if (stale) build(key, fn, now).catch(() => { /* keep serving the last good value */ });
    return { value: hit.value, computedAt: hit.computedAt, stale };
  }
  const entry = await build(key, fn, now);
  return { value: entry.value, computedAt: entry.computedAt, stale: false };
}
