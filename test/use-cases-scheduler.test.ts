// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';

let setConfigValue: typeof import('@/lib/config').setConfigValue;
let getConfigValue: typeof import('@/lib/config').getConfigValue;
let runUseCaseTrackerJob: typeof import('@/lib/usecases/tracker').runUseCaseTrackerJob;

// The tracker job reads and writes config (and telemetry) through getClient(),
// so give it a migrated test database rather than whatever default database
// the environment points at.
let cleanup: () => Promise<void>;
beforeAll(async () => {
  ({ cleanup } = await createTestDatabase());
  ({ setConfigValue, getConfigValue } = await import('@/lib/config'));
  ({ runUseCaseTrackerJob } = await import('@/lib/usecases/tracker'));
});
afterAll(async () => cleanup());

describe('use-case tracker job gating', () => {
  it('no-ops when useCasesEnabled is off', async () => {
    await setConfigValue('useCasesEnabled', 'false');
    await setConfigValue('useCasesTrackerLastRun', '');
    await runUseCaseTrackerJob();
    expect(await getConfigValue('useCasesTrackerLastRun')).toBe('');
  });

  it('runs when enabled and stamps last-run', async () => {
    await setConfigValue('useCasesEnabled', 'true');
    await setConfigValue('useCasesTrackerLastRun', '');
    await runUseCaseTrackerJob();
    expect(await getConfigValue('useCasesTrackerLastRun')).not.toBe('');
  });

  it('honours the cadence knob', async () => {
    await setConfigValue('useCasesEnabled', 'true');
    await setConfigValue('useCasesTrackerIntervalHours', '6');
    const stamp = new Date(Date.now() - 2 * 3600 * 1000).toISOString(); // 2h ago < 6h interval
    await setConfigValue('useCasesTrackerLastRun', stamp);
    await runUseCaseTrackerJob();
    expect(await getConfigValue('useCasesTrackerLastRun')).toBe(stamp); // unchanged — skipped
  });
});
