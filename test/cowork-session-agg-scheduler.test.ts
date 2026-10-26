// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';

let setConfigValue: typeof import('@/lib/config').setConfigValue;
let getConfigValue: typeof import('@/lib/config').getConfigValue;
let runCoworkSessionAggJob: typeof import('@/lib/pulse/cowork/session-aggregator').runCoworkSessionAggJob;
let cleanup: () => Promise<void>;

// The job and config helpers read the database, so give them a migrated test
// one rather than whatever default DB the process has.
beforeAll(async () => {
  const t = await createTestDatabase();
  cleanup = t.cleanup;
  ({ setConfigValue, getConfigValue } = await import('@/lib/config'));
  ({ runCoworkSessionAggJob } = await import('@/lib/pulse/cowork/session-aggregator'));
});

afterAll(async () => cleanup());

describe('cowork session-stats aggregation job gating', () => {
  it('runs and stamps last-run when no prior run is recorded', async () => {
    await setConfigValue('coworkSessionAggLastRun', '');
    await runCoworkSessionAggJob();
    expect(await getConfigValue('coworkSessionAggLastRun')).not.toBe('');
  });

  it('honours the hardcoded hourly cadence — skips a run inside the last hour', async () => {
    const stamp = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    await setConfigValue('coworkSessionAggLastRun', stamp);
    await runCoworkSessionAggJob();
    expect(await getConfigValue('coworkSessionAggLastRun')).toBe(stamp); // unchanged — skipped
  });

  it('runs again once the hourly cadence has elapsed', async () => {
    const stamp = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago > 1h interval
    await setConfigValue('coworkSessionAggLastRun', stamp);
    await runCoworkSessionAggJob();
    expect(await getConfigValue('coworkSessionAggLastRun')).not.toBe(stamp);
  });
});
