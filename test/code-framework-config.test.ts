// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';

let getAllConfig: typeof import('@/lib/config').getAllConfig;
let cleanup: () => Promise<void>;

// getAllConfig reads the config table, so give it a migrated test DB
// rather than whatever default DB the process would open.
beforeAll(async () => {
  const testDb = await createTestDatabase();
  cleanup = testDb.cleanup;
  getAllConfig = (await import('@/lib/config')).getAllConfig;
});

afterAll(async () => cleanup());

describe('dev framework alignment config', () => {
  it('defaults dxFrameworkEnabled to false and mock to "false"', async () => {
    const cfg = await getAllConfig();
    expect(cfg.dxFrameworkEnabled).toBe(false);
    expect(cfg.dxFrameworkMock).toBe('false');
    expect(typeof cfg.dxApiKey).toBe('string');
    expect(typeof cfg.dxInstanceUrl).toBe('string');
  });
});
