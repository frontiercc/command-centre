// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// lib/kept-figures.ts: the heavy pages' figures are built once, served from memory, refreshed in
// the background (on a visit once five minutes old, and by the scheduler's refresh run), and
// prepared from start-up for the organisation-wide pages. A failure is never kept.
import { describe, it, expect, beforeEach } from 'vitest';
import { keptFigures, clearKeptFigures, keepWarm, refreshKeptFigures, forgetKeptFigures, KEPT_FRESH_MS, REFRESH_EVERY_MS, ASKED_WITHIN_MS } from '@/lib/kept-figures';

let clock = 1_000_000;
const now = () => clock;
const tick = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  clearKeptFigures();
  clock = 1_000_000;
});

describe('keptFigures', () => {
  it('builds once, then serves the kept value', async () => {
    let builds = 0;
    const fn = async () => ++builds;
    expect(await keptFigures('k', fn, { now })).toBe(1);
    expect(await keptFigures('k', fn, { now })).toBe(1);
    expect(builds).toBe(1);
  });

  it('serves a stale value at once and rebuilds it in the background', async () => {
    let builds = 0;
    const fn = async () => ++builds;
    await keptFigures('k', fn, { now });
    clock += KEPT_FRESH_MS;
    expect(await keptFigures('k', fn, { now })).toBe(1); // the old value, no wait
    await tick();
    expect(builds).toBe(2);
    expect(await keptFigures('k', fn, { now })).toBe(2);
  });

  it('runs one build per key when several requests arrive together', async () => {
    let builds = 0;
    const fn = async () => { await tick(); return ++builds; };
    const [a, b] = await Promise.all([keptFigures('k', fn, { now }), keptFigures('k', fn, { now })]);
    expect([a, b]).toEqual([1, 1]);
    expect(builds).toBe(1);
  });

  it('never keeps a build that threw', async () => {
    let calls = 0;
    const fn = async () => { calls++; if (calls === 1) throw new Error('down'); return 'ok'; };
    await expect(keptFigures('k', fn, { now })).rejects.toThrow('down');
    expect(await keptFigures('k', fn, { now })).toBe('ok');
  });

  it('returns but does not keep a result with a failed part', async () => {
    let builds = 0;
    const fn = async () => ({ n: ++builds, failed: builds === 1 ? ['spend'] : [] });
    const keep = (v: { failed: string[] }) => v.failed.length === 0;
    expect((await keptFigures('k', fn, { now, keep })).n).toBe(1);
    expect((await keptFigures('k', fn, { now, keep })).n).toBe(2);
    expect((await keptFigures('k', fn, { now, keep })).n).toBe(2);
  });

  it('keeps the last good value when a background rebuild fails', async () => {
    let calls = 0;
    const fn = async () => { calls++; if (calls === 2) throw new Error('down'); return calls; };
    await keptFigures('k', fn, { now });
    clock += KEPT_FRESH_MS;
    expect(await keptFigures('k', fn, { now })).toBe(1);
    await tick();
    expect(await keptFigures('k', fn, { now })).toBe(1);
  });

  it('builds afresh when forced, after the person changed something', async () => {
    let builds = 0;
    const fn = async () => ++builds;
    await keptFigures('k', fn, { now });
    expect(await keptFigures('k', fn, { now, force: true })).toBe(2);
    expect(await keptFigures('k', fn, { now })).toBe(2);
  });

  it('keeps different keys apart', async () => {
    expect(await keptFigures('all', async () => 'all', { now })).toBe('all');
    expect(await keptFigures('openai', async () => 'openai', { now })).toBe('openai');
  });
});

describe('refreshKeptFigures', () => {
  it('prepares the start-up views before anyone asks, so the first visit does not build', async () => {
    let builds = 0;
    keepWarm(async () => [{ key: 'dashboard:all', build: async () => ++builds }]);
    const r = await refreshKeptFigures({ now });
    expect(r).toMatchObject({ refreshed: 1, failed: 0, left: 0 });
    expect(await keptFigures('dashboard:all', async () => -1, { now })).toBe(1);
    expect(builds).toBe(1);
  });

  it('rebuilds a view once it is a refresh interval old, and leaves a newer one alone', async () => {
    let builds = 0;
    const fn = async () => ++builds;
    await keptFigures('k', fn, { now });
    expect((await refreshKeptFigures({ now })).refreshed).toBe(0); // just built
    clock += REFRESH_EVERY_MS;
    expect((await refreshKeptFigures({ now })).refreshed).toBe(1);
    expect(await keptFigures('k', fn, { now })).toBe(2); // the refreshed value, no wait
  });

  it('stops refreshing a view nobody has asked for in a day', async () => {
    let builds = 0;
    await keptFigures('k', async () => ++builds, { now });
    clock += ASKED_WITHIN_MS + 1;
    const r = await refreshKeptFigures({ now });
    expect(r).toMatchObject({ refreshed: 0, dropped: 1 });
    expect(builds).toBe(1);
  });

  it('keeps the last good value when a rebuild fails, and counts the failure', async () => {
    let fail = false;
    await keptFigures('k', async () => { if (fail) throw new Error('down'); return 'good'; }, { now });
    fail = true;
    clock += REFRESH_EVERY_MS;
    const r = await refreshKeptFigures({ now });
    expect(r).toMatchObject({ refreshed: 0, failed: 1 });
    expect(await keptFigures('k', async () => 'unused', { now })).toBe('good');
  });

  it('stops at its time budget and leaves the rest for the next run', async () => {
    keepWarm(async () => [
      { key: 'a', build: async () => { clock += 1000; return 'a'; } },
      { key: 'b', build: async () => 'b' },
    ]);
    const r = await refreshKeptFigures({ now, budgetMs: 500 });
    expect(r).toMatchObject({ refreshed: 1, left: 1 });
  });

  it('forgets kept results by prefix, so the next visit builds afresh', async () => {
    let builds = 0;
    const fn = async () => ++builds;
    await keptFigures('chargeback:2026-11', fn, { now });
    await keptFigures('dashboard:all', fn, { now });
    forgetKeptFigures('chargeback:');
    expect(await keptFigures('chargeback:2026-11', fn, { now })).toBe(3);
    expect(await keptFigures('dashboard:all', fn, { now })).toBe(2);
  });
});
