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

describe('chargeback flag default', () => {
  it('defaults chargebackEnabled to false', async () => {
    const { getAllConfig } = await import('@/lib/config');
    expect((await getAllConfig()).chargebackEnabled).toBe(false); // boolean, coerced — mirrors useCasesEnabled
  });
});
