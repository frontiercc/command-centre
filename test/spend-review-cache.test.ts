// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Spend Review cache: builds once, serves a fresh value without rebuilding,
// serves a stale value at once while rebuilding in the background, rebuilds
// on a forced refresh, shares one build between concurrent callers, and keeps
// the last good value when a background rebuild fails.
import { describe, it, expect, beforeEach } from 'vitest';
import { cached, clearSpendReviewCache } from '@/lib/finance/spend-review-cache';

const flush = () => new Promise(r => setTimeout(r, 0));

describe('spend review cache', () => {
  let now = 1_000_000;
  const clock = () => now;
  beforeEach(() => { clearSpendReviewCache(); now = 1_000_000; });

  it('builds once and serves the kept value while fresh', async () => {
    let builds = 0;
    const fn = async () => ++builds;
    expect((await cached('k', 1000, fn, { now: clock })).value).toBe(1);
    now += 500;
    const again = await cached('k', 1000, fn, { now: clock });
    expect(again).toMatchObject({ value: 1, stale: false });
    expect(builds).toBe(1);
  });

  it('serves a stale value at once and rebuilds it in the background', async () => {
    let builds = 0;
    const fn = async () => ++builds;
    await cached('k', 1000, fn, { now: clock });
    now += 2000;
    const stale = await cached('k', 1000, fn, { now: clock });
    expect(stale).toMatchObject({ value: 1, stale: true });
    await flush();
    expect((await cached('k', 1000, fn, { now: clock })).value).toBe(2);
  });

  it('rebuilds on a forced refresh, and shares one build between concurrent callers', async () => {
    let builds = 0;
    const fn = async () => { await flush(); return ++builds; };
    const [a, b] = await Promise.all([cached('k', 1000, fn, { now: clock }), cached('k', 1000, fn, { now: clock })]);
    expect(a.value).toBe(1);
    expect(b.value).toBe(1);
    expect((await cached('k', 1000, fn, { now: clock, force: true })).value).toBe(2);
  });

  it('keeps the last good value when a background rebuild fails', async () => {
    let fail = false;
    const fn = async () => { if (fail) throw new Error('db down'); return 'good'; };
    await cached('k', 1000, fn, { now: clock });
    fail = true;
    now += 2000;
    expect((await cached('k', 1000, fn, { now: clock })).value).toBe('good');
    await flush();
    expect((await cached('k', 1000, fn, { now: clock })).value).toBe('good');
  });
});
