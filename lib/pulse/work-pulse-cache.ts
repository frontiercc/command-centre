// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// In-process cache for Work Pulse's organisation-wide figures, the same pattern as Spend Review's
// (lib/finance/spend-review-cache.ts). These pages read every judged prompt and session in their
// window, which grows with the hub: on a large one a page took several seconds on every load.
// A result is kept for WORK_PULSE_FRESH_MS; once older, the kept result is served at once and
// rebuilt in the background (stale-while-revalidate), so after the first load nobody waits.
// One build per key at a time.
//
// Only figures that are the same for every viewer are kept, keyed by everything they depend on
// (the vendor view, the window, the team). Who may see them is still decided on every request.
// A result with a part that failed to build is returned but never kept, so the next load tries
// again instead of showing "couldn't load" for five minutes.
//
// Per instance, by design: a hub behind several instances keeps one cache each, which costs a
// duplicate build, never a wrong answer.

export const WORK_PULSE_FRESH_MS = 5 * 60 * 1000;
/** Bound on kept results: a handful of views and windows, times the teams. */
const MAX_ENTRIES = 300;

interface Entry<T> { value: T; computedAt: number; }

const entries = new Map<string, Entry<unknown>>();
const inFlight = new Map<string, Promise<Entry<unknown>>>();

/** Test hook. */
export function clearWorkPulseCache(): void {
  entries.clear();
  inFlight.clear();
}

function build<T>(key: string, fn: () => Promise<T>, keep: (v: T) => boolean, now: () => number): Promise<Entry<T>> {
  const running = inFlight.get(key) as Promise<Entry<T>> | undefined;
  if (running) return running;
  const p = fn()
    .then(value => {
      const entry: Entry<T> = { value, computedAt: now() };
      if (keep(value)) {
        entries.delete(key); // re-insert so Map order is least-recently-built first
        entries.set(key, entry);
        while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
      }
      return entry;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p as Promise<Entry<unknown>>);
  return p;
}

/**
 * The kept value for `key`, building it when absent. A stale value is returned at once and
 * rebuilt in the background; a background failure keeps the last good value. A build that
 * throws is never kept, and neither is one `keep` turns down. `force` builds afresh, for a page
 * reloading right after the person changed something it shows.
 */
export async function cachedWorkPulse<T>(
  key: string,
  fn: () => Promise<T>,
  opts: { keep?: (value: T) => boolean; force?: boolean; freshMs?: number; now?: () => number } = {},
): Promise<T> {
  const now = opts.now ?? Date.now;
  const keep = opts.keep ?? (() => true);
  const freshMs = opts.freshMs ?? WORK_PULSE_FRESH_MS;
  const hit = entries.get(key) as Entry<T> | undefined;
  if (hit && !opts.force) {
    if (now() - hit.computedAt >= freshMs) {
      // The key carries request values, so it is logged as data, never as the format string.
      build(key, fn, keep, now).catch(err => console.error('[work-pulse-cache] background rebuild failed for key %s', key, err));
    }
    return hit.value;
  }
  return (await build(key, fn, keep, now)).value;
}
