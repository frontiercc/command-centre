// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { WeekActivity } from '@/lib/usecases/weeks';

let cleanup: () => Promise<void>;

let deriveLifecycle: typeof import('@/lib/usecases/lifecycle').deriveLifecycle;
let getLifecycleConfig: typeof import('@/lib/usecases/lifecycle').getLifecycleConfig;
type LifecycleConfig = import('@/lib/usecases/lifecycle').LifecycleConfig;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  cleanup = testDb.cleanup;

  const lifecycle = await import('@/lib/usecases/lifecycle');
  deriveLifecycle = lifecycle.deriveLifecycle;
  getLifecycleConfig = lifecycle.getLifecycleConfig;
});

afterAll(async () => cleanup());

const CFG: LifecycleConfig = { adoptedMinWeeks: 3, adoptedMinUsers: 2, atRiskQuietWeeks: 2, notSeenQuietWeeks: 6 };
const wk = (i: number, msgs: number, users = msgs > 0 ? 1 : 0): WeekActivity =>
  ({ weekStart: i * 604800, distinctUsers: users, sessionCount: msgs > 0 ? 1 : 0, matchedMessages: msgs, latestTier: null, lastSeenAt: null });

describe('deriveLifecycle', () => {
  it('empty history → not_seen', () => {
    expect(deriveLifecycle('not_seen', [], null, 0, CFG)).toBe('not_seen');
  });
  it('current-week activity promotes not_seen → piloting', () => {
    expect(deriveLifecycle('not_seen', [], wk(4, 3), 1, CFG)).toBe('piloting');
  });
  it('3 of 4 active weeks + 2 users → adopted', () => {
    expect(deriveLifecycle('piloting', [wk(0, 2), wk(1, 2), wk(2, 0), wk(3, 2)], null, 2, CFG)).toBe('adopted');
  });
  it('3 of 4 active weeks but only 1 distinct user → NOT adopted (piloting)', () => {
    expect(deriveLifecycle('piloting', [wk(0, 2), wk(1, 2), wk(2, 2), wk(3, 2)], null, 1, CFG)).toBe('piloting');
  });
  it('piloting + 2 quiet completed weeks, quiet current week → at_risk', () => {
    expect(deriveLifecycle('piloting', [wk(0, 5), wk(1, 5), wk(2, 0), wk(3, 0)], wk(4, 0), 1, CFG)).toBe('at_risk');
  });
  it('current-week activity blocks the at_risk demotion', () => {
    expect(deriveLifecycle('piloting', [wk(0, 5), wk(1, 5), wk(2, 0), wk(3, 0)], wk(4, 1), 1, CFG)).toBe('piloting');
  });
  it('adopted survives a single quiet week', () => {
    expect(deriveLifecycle('adopted', [wk(0, 5, 2), wk(1, 5, 2), wk(2, 5, 2), wk(3, 0)], wk(4, 0), 2, CFG)).toBe('adopted');
  });
  it('at_risk is sticky while quiet, decays to not_seen after 6 quiet weeks', () => {
    const quiet6 = [wk(0, 5), wk(1, 0), wk(2, 0), wk(3, 0), wk(4, 0), wk(5, 0), wk(6, 0)];
    expect(deriveLifecycle('at_risk', quiet6.slice(0, 5), wk(5, 0), 1, CFG)).toBe('at_risk');
    expect(deriveLifecycle('at_risk', quiet6, wk(7, 0), 1, CFG)).toBe('not_seen');
  });
  it('never-tracked stale activity with current=not_seen stays not_seen', () => {
    expect(deriveLifecycle('not_seen', [wk(0, 3), wk(1, 0), wk(2, 0)], wk(3, 0), 1, CFG)).toBe('not_seen');
  });
  it('config overrides are honoured (adoptedMinWeeks=1, minUsers=1)', () => {
    const loose = { ...CFG, adoptedMinWeeks: 1, adoptedMinUsers: 1 };
    expect(deriveLifecycle('not_seen', [wk(3, 1)], null, 1, loose)).toBe('adopted');
  });
  it('getLifecycleConfig falls back to defaults on empty config', async () => {
    expect(await getLifecycleConfig()).toEqual({ adoptedMinWeeks: 3, adoptedMinUsers: 2, atRiskQuietWeeks: 2, notSeenQuietWeeks: 6 });
  });
});
