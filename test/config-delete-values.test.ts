// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';

describe('deleteConfigValues', () => {
  let cleanup: () => Promise<void>;
  let cfg: typeof import('@/lib/config');

  beforeAll(async () => {
    const t = await createTestDatabase();
    cleanup = t.cleanup;
    cfg = await import('@/lib/config');
  });
  afterAll(async () => cleanup());

  it('deletes the named keys and leaves others untouched', async () => {
    await cfg.setConfigValue('complianceAccessKey', 'sk-ant-api01-test');
    await cfg.setConfigValue('complianceChatCursor', 'cursor-abc');
    await cfg.setConfigValue('organisationName', 'Acme Corp');

    await cfg.deleteConfigValues(['complianceAccessKey', 'complianceChatCursor']);

    expect(await cfg.getConfigValue('complianceAccessKey')).toBe('');
    expect(await cfg.getConfigValue('complianceChatCursor')).toBe('');
    expect(await cfg.getConfigValue('organisationName')).toBe('Acme Corp');
  });

  it('is idempotent — deleting absent keys is a no-op', async () => {
    await expect(cfg.deleteConfigValues(['complianceAccessKey'])).resolves.toBeUndefined();
  });

  it('empty array is a no-op', async () => {
    await expect(cfg.deleteConfigValues([])).resolves.toBeUndefined();
  });
});
