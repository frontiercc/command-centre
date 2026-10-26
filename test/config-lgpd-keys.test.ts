// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';

describe('LGPD config keys — defaults keep existing instances unchanged', () => {
  let cleanup: () => Promise<void>;
  let cfg: typeof import('@/lib/config');

  beforeAll(async () => {
    const t = await createTestDatabase();
    cleanup = t.cleanup;
    cfg = await import('@/lib/config');
  });
  afterAll(async () => cleanup());

  it('gdprApplicable defaults TRUE (GDPR stays on everywhere until explicitly unticked)', async () => {
    const c = await cfg.getAllConfig();
    expect(c.gdprApplicable).toBe(true);
  });
  it('lgpdApplicable defaults FALSE (dormant until a Brazilian admin ticks it)', async () => {
    const c = await cfg.getAllConfig();
    expect(c.lgpdApplicable).toBe(false);
  });
  it('encarregado and RIPD fields default empty/false', async () => {
    const c = await cfg.getAllConfig();
    expect(c.dataProtectionEncarregado).toBe('');
    expect(c.ripdCompleted).toBe(false);
    expect(c.ripdDate).toBe('');
  });
});
