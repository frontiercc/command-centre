// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';

// getAllConfig reads the config table, so give it a migrated test database
// rather than whatever default one getClient() would open.
let cleanup: () => Promise<void>;
beforeAll(async () => {
  ({ cleanup } = await createTestDatabase());
});
afterAll(async () => cleanup());

describe('finops v2 config defaults', () => {
  it('defaults insight model + drift threshold + enterprise mock', async () => {
    const { getAllConfig } = await import('@/lib/config');
    const c = await getAllConfig();
    expect(c.financeInsightModel).toBe('claude-haiku-4-5-20251001');
    expect(c.financeDriftAlertThresholdPct).toBe('10');
    expect(c.financeEnterpriseMock).toBe('false');
  });
});
