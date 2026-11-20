// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Kept figures for the heavy pages: Work Pulse, Developer Pulse, the dashboard, the Users list and
// FinOps. These pages read every judged prompt, session and model call in their window, which
// grows with the hub, so working their figures out while someone waits took seconds.
//
// Each page's figures are kept here, keyed by everything they depend on (the vendor view, the
// window, the team, and the viewer where the figures differ by viewer). Who may see them is still
// decided on every request, before this cache is asked.
//
// Two things keep them current without anyone waiting:
//  - refreshKeptFigures(), run by the scheduler every REFRESH_EVERY_MS, rebuilds every view asked
//    for in the last ASKED_WITHIN_MS, plus the organisation-wide views registered with
//    keepWarm() so they are ready from start-up. A page is therefore at most a few minutes behind.
//  - Between refreshes, a kept result older than KEPT_FRESH_MS is still served at once and
//    rebuilt in the background (stale-while-revalidate), which covers an instance that does not
//    run the scheduler.
// One build per key at a time. A result with a part that failed to build is returned but never
// kept, so the next load tries again instead of showing "couldn't load" for five minutes.
//
// Per instance, by design: a hub behind several instances keeps one cache each, which costs a
// duplicate build, never a wrong answer. Only the instance running the scheduler refreshes ahead.

export const KEPT_FRESH_MS = 5 * 60 * 1000;
/** How often the scheduler rebuilds kept figures. */
export const REFRESH_EVERY_MS = 5 * 60 * 1000;
/** A view nobody has asked for in this long stops being refreshed and is dropped. */
export const ASKED_WITHIN_MS = 24 * 60 * 60 * 1000;
/** Wall-clock budget for one refresh run; what is left is refreshed on the next run. */
const REFRESH_BUDGET_MS = 3 * 60 * 1000;
/** Bound on kept results and on the views refreshed: a handful of views and windows, times the teams and viewers. */
const MAX_ENTRIES = 300;

interface Entry<T> { value: T; computedAt: number; }

interface Builder {
  build: () => Promise<unknown>;
  keep: (value: unknown) => boolean;
  lastAsked: number;
}

export interface WarmView { key: string; build: () => Promise<unknown>; keep?: (value: unknown) => boolean }

interface Store {
  entries: Map<string, Entry<unknown>>;
  inFlight: Map<string, Promise<Entry<unknown>>>;
  /** How to rebuild each view people have asked for, so the scheduler can refresh it. */
  builders: Map<string, Builder>;
  /** Views kept ready from start-up, whether or not anyone has asked: re-read on every refresh run. */
  warmLists: Array<() => Promise<WarmView[]>>;
}

// One store per process, on globalThis: Next.js can load this file once for the route handlers and
// again for the scheduler started from instrumentation, and both must use the same kept figures.
const holder = globalThis as unknown as { __keptFigures?: Store };
holder.__keptFigures ??= { entries: new Map(), inFlight: new Map(), builders: new Map(), warmLists: [] };
const { entries, inFlight, builders, warmLists } = holder.__keptFigures;

/** Test hook. */
export function clearKeptFigures(): void {
  entries.clear();
  inFlight.clear();
  builders.clear();
  warmLists.length = 0;
}

/**
 * Drops every kept result whose key starts with `prefix`, for a change that makes them wrong
 * (closing a month, editing cost centres). The next request builds afresh.
 */
export function forgetKeptFigures(prefix: string): void {
  for (const key of [...entries.keys()]) if (key.startsWith(prefix)) entries.delete(key);
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

function remember(key: string, fn: () => Promise<unknown>, keep: (v: unknown) => boolean, at: number): void {
  builders.delete(key); // re-insert so Map order is least-recently-asked first
  builders.set(key, { build: fn, keep, lastAsked: at });
  while (builders.size > MAX_ENTRIES) builders.delete(builders.keys().next().value as string);
}

/**
 * The kept value for `key`, building it when absent. A stale value is returned at once and
 * rebuilt in the background; a background failure keeps the last good value. A build that
 * throws is never kept, and neither is one `keep` turns down. `force` builds afresh, for a page
 * reloading right after the person changed something it shows.
 */
export async function keptFigures<T>(
  key: string,
  fn: () => Promise<T>,
  opts: { keep?: (value: T) => boolean; force?: boolean; freshMs?: number; now?: () => number } = {},
): Promise<T> {
  const now = opts.now ?? Date.now;
  const keep = opts.keep ?? (() => true);
  const freshMs = opts.freshMs ?? KEPT_FRESH_MS;
  remember(key, fn, keep as (v: unknown) => boolean, now());
  const hit = entries.get(key) as Entry<T> | undefined;
  if (hit && !opts.force) {
    if (now() - hit.computedAt >= freshMs) {
      // The key carries request values, so it is logged as data, never as the format string.
      build(key, fn, keep, now).catch(err => console.error('[kept-figures] background rebuild failed for key %s', key, err));
    }
    return hit.value;
  }
  return (await build(key, fn, keep, now)).value;
}

/**
 * Registers views to keep ready from start-up, before anyone asks: the organisation-wide pages
 * that every viewer allowed in sees the same way. The list is re-read on every refresh run, so it
 * follows the current month and which products are connected.
 */
export function keepWarm(list: () => Promise<WarmView[]>): void {
  warmLists.push(list);
}

export interface RefreshResult { refreshed: number; failed: number; left: number; dropped: number }

/**
 * Rebuilds kept figures: every registered start-up view, and every view asked for within
 * ASKED_WITHIN_MS, oldest first, one at a time so the database is never flooded. Views nobody
 * has asked for in that time are dropped. Stops at the run's time budget; the rest wait for the
 * next run (and are still served, a little older, meanwhile). A failed build keeps the last good
 * result.
 */
export async function refreshKeptFigures(opts: { now?: () => number; budgetMs?: number } = {}): Promise<RefreshResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  const budget = opts.budgetMs ?? REFRESH_BUDGET_MS;

  let dropped = 0;
  for (const [key, b] of [...builders]) {
    if (started - b.lastAsked > ASKED_WITHIN_MS) {
      builders.delete(key);
      entries.delete(key);
      dropped++;
    }
  }

  const todo = new Map<string, { build: () => Promise<unknown>; keep: (v: unknown) => boolean }>();
  for (const list of warmLists) {
    try {
      for (const w of await list()) todo.set(w.key, { build: w.build, keep: w.keep ?? (() => true) });
    } catch (err) {
      console.error('[kept-figures] could not list the start-up views', err);
    }
  }
  for (const [key, b] of builders) if (!todo.has(key)) todo.set(key, { build: b.build, keep: b.keep });

  // Missing first, then oldest; a view rebuilt within the last refresh interval is left alone.
  const age = (key: string) => {
    const e = entries.get(key);
    return e ? started - e.computedAt : Number.MAX_SAFE_INTEGER;
  };
  const due = [...todo.keys()]
    .filter(key => age(key) >= REFRESH_EVERY_MS - 30_000)
    .sort((a, b) => age(b) - age(a));

  let refreshed = 0;
  let failed = 0;
  let i = 0;
  for (; i < due.length; i++) {
    if (now() - started >= budget) break;
    const key = due[i];
    const t = todo.get(key)!;
    try {
      await build(key, t.build, t.keep, now);
      refreshed++;
    } catch (err) {
      failed++;
      console.error('[kept-figures] refresh failed for key %s', key, err);
    }
  }
  return { refreshed, failed, left: due.length - i, dropped };
}
