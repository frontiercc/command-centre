// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Which key spend limits are read with. Anthropic's spend limits need a Claude
// Enterprise key with read:spend_limits; a Claude Console admin key cannot
// read them. So the Analytics API key comes first, and the Admin API key field
// is only a fallback for an Enterprise key saved there.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const cfg: Record<string, string> = {};
vi.mock('@/lib/config', () => ({ getConfigValue: async (key: string) => cfg[key] ?? '' }));

import { spendLimitsApiKey } from '@/lib/anthropic/spend-limits';

beforeEach(() => {
  cfg.anthropicAnalyticsApiKey = '';
  cfg.anthropicAdminApiKey = '';
});

describe('spendLimitsApiKey', () => {
  it('uses the Analytics API key when both are set', async () => {
    cfg.anthropicAnalyticsApiKey = 'analytics-key';
    cfg.anthropicAdminApiKey = 'admin-key';
    expect(await spendLimitsApiKey()).toBe('analytics-key');
  });

  it('falls back to the Admin API key field', async () => {
    cfg.anthropicAdminApiKey = ' admin-key ';
    expect(await spendLimitsApiKey()).toBe('admin-key');
  });

  it('is empty when neither is set', async () => {
    expect(await spendLimitsApiKey()).toBe('');
  });
});
