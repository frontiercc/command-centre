// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getConfigValue = vi.fn();
vi.mock('@/lib/config', () => ({ getConfigValue: (...a: unknown[]) => getConfigValue(...a) }));

describe('getCoreAiModel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the configured model when set', async () => {
    getConfigValue.mockResolvedValue('claude-opus-4-5-20251001');
    const { getCoreAiModel } = await import('@/lib/anthropic/model');
    expect(await getCoreAiModel()).toBe('claude-opus-4-5-20251001');
  });

  it('falls back to the Haiku default when unset (empty string)', async () => {
    getConfigValue.mockResolvedValue('');
    const { getCoreAiModel } = await import('@/lib/anthropic/model');
    expect(await getCoreAiModel()).toBe('claude-haiku-4-5-20251001');
  });
});
