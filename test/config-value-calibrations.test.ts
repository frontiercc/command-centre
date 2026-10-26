// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';

describe('Value calibration config', () => {
  let cleanup: () => Promise<void>;
  let cfg: typeof import('@/lib/config');
  beforeAll(async () => { const t = await createTestDatabase(); cleanup = t.cleanup; cfg = await import('@/lib/config'); });
  afterAll(async () => cleanup());

  it('defaults: lift 30, comp 300000, coding hrs 15, enabled true; team/spend empty', async () => {
    const c = (await cfg.getAllConfig());
    expect(c.codeValueLiftPct).toBe('30');
    expect(c.codeValueLoadedComp).toBe('300000');
    expect(c.codeValueCodingHrs).toBe('15');
    expect(c.codeValueEnabled).toBe(true);
    expect(c.codeValueTeamSize).toBe('');
    expect(c.codeValueAnnualSpend).toBe('');
  });

  it('persists an override via setConfigValue', async () => {
    await cfg.setConfigValue('codeValueLiftPct', '22');
    expect(await cfg.getConfigValue('codeValueLiftPct')).toBe('22');
  });
});
