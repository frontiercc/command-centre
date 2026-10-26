// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// test/wait-for-db.test.ts
import { describe, it, expect, vi } from 'vitest';
import { waitForDb } from '../scripts/wait-for-db.mjs';

const noop = () => {};
const instantSleep = async () => {};

describe('waitForDb', () => {
  it('returns ready when the probe eventually succeeds', async () => {
    let calls = 0;
    const probe = vi.fn(async () => (++calls >= 3));
    const res = await waitForDb({
      probe, intervalMs: 1, timeoutMs: 10_000,
      sleep: instantSleep, now: (() => { let t = 0; return () => (t += 1); })(), log: noop,
    });
    expect(res.ready).toBe(true);
    expect(res.timedOut).toBe(false);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('times out and returns not-ready without throwing', async () => {
    const probe = vi.fn(async () => false);
    // Virtual clock: each now() call advances 3s so the loop crosses 300s quickly.
    let t = 0;
    const now = () => (t += 3000);
    const res = await waitForDb({
      probe, intervalMs: 1, timeoutMs: 300_000,
      sleep: instantSleep, now, log: noop,
    });
    expect(res.ready).toBe(false);
    expect(res.timedOut).toBe(true);
  });

  it('swallows a probe that throws and keeps polling', async () => {
    let calls = 0;
    const probe = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('ECONNREFUSED');
      return true;
    });
    const res = await waitForDb({
      probe, intervalMs: 1, timeoutMs: 10_000,
      sleep: instantSleep, now: (() => { let t = 0; return () => (t += 1); })(), log: noop,
    });
    expect(res.ready).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
