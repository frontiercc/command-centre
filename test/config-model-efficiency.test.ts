// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';

let cleanup: () => Promise<void>;
let getAllConfig: typeof import('@/lib/config').getAllConfig;

// getAllConfig() reads the config table, so the file needs its own database.
beforeAll(async () => {
  const t = await createTestDatabase();
  cleanup = t.cleanup;
  ({ getAllConfig } = await import('@/lib/config'));
});
afterAll(async () => cleanup());

describe('financeModelEfficiencyEnabled', () => {
  it('defaults to false when unset', async () => {
    const cfg = await getAllConfig();
    expect(cfg.financeModelEfficiencyEnabled).toBe(false);
  });
});
