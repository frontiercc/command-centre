// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// lib/pulse/work-pulse-cache.ts: Work Pulse's organisation-wide figures are built once, served
// from memory for five minutes, then refreshed in the background. A failure is never kept.
import { describe, it, expect, beforeEach } from 'vitest';
import { cachedWorkPulse, clearWorkPulseCache, WORK_PULSE_FRESH_MS } from '@/lib/pulse/work-pulse-cache';

let clock = 1_000_000;
const now = () => clock;
const tick = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  clearWorkPulseCache();
  clock = 1_000_000;
});

describe('cachedWorkPulse', () => {
  it('builds once, then serves the kept value', async () => {
    let builds = 0;
    const fn = async () => ++builds;
    expect(await cachedWorkPulse('k', fn, { now })).toBe(1);
    expect(await cachedWorkPulse('k', fn, { now })).toBe(1);
    expect(builds).toBe(1);
  });

  it('serves a stale value at once and rebuilds it in the background', async () => {
    let builds = 0;
    const fn = async () => ++builds;
    await cachedWorkPulse('k', fn, { now });
    clock += WORK_PULSE_FRESH_MS;
    expect(await cachedWorkPulse('k', fn, { now })).toBe(1); // the old value, no wait
    await tick();
    expect(builds).toBe(2);
    expect(await cachedWorkPulse('k', fn, { now })).toBe(2);
  });

  it('runs one build per key when several requests arrive together', async () => {
    let builds = 0;
    const fn = async () => { await tick(); return ++builds; };
    const [a, b] = await Promise.all([cachedWorkPulse('k', fn, { now }), cachedWorkPulse('k', fn, { now })]);
    expect([a, b]).toEqual([1, 1]);
    expect(builds).toBe(1);
  });

  it('never keeps a build that threw', async () => {
    let calls = 0;
    const fn = async () => { calls++; if (calls === 1) throw new Error('down'); return 'ok'; };
    await expect(cachedWorkPulse('k', fn, { now })).rejects.toThrow('down');
    expect(await cachedWorkPulse('k', fn, { now })).toBe('ok');
  });

  it('returns but does not keep a result with a failed part', async () => {
    let builds = 0;
    const fn = async () => ({ n: ++builds, failed: builds === 1 ? ['spend'] : [] });
    const keep = (v: { failed: string[] }) => v.failed.length === 0;
    expect((await cachedWorkPulse('k', fn, { now, keep })).n).toBe(1);
    expect((await cachedWorkPulse('k', fn, { now, keep })).n).toBe(2);
    expect((await cachedWorkPulse('k', fn, { now, keep })).n).toBe(2);
  });

  it('keeps the last good value when a background rebuild fails', async () => {
    let calls = 0;
    const fn = async () => { calls++; if (calls === 2) throw new Error('down'); return calls; };
    await cachedWorkPulse('k', fn, { now });
    clock += WORK_PULSE_FRESH_MS;
    expect(await cachedWorkPulse('k', fn, { now })).toBe(1);
    await tick();
    expect(await cachedWorkPulse('k', fn, { now })).toBe(1);
  });

  it('builds afresh when forced, after the person changed something', async () => {
    let builds = 0;
    const fn = async () => ++builds;
    await cachedWorkPulse('k', fn, { now });
    expect(await cachedWorkPulse('k', fn, { now, force: true })).toBe(2);
    expect(await cachedWorkPulse('k', fn, { now })).toBe(2);
  });

  it('keeps different keys apart', async () => {
    expect(await cachedWorkPulse('all', async () => 'all', { now })).toBe('all');
    expect(await cachedWorkPulse('openai', async () => 'openai', { now })).toBe('openai');
  });
});
