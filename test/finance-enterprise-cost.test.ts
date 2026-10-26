// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mutable config stub — each test sets the values it needs before importing.
const cfg: Record<string, string> = {};
vi.mock('@/lib/config', () => ({
  getConfigValue: (key: string) => cfg[key] ?? '',
}));

import { fetchEnterpriseCost, getEnterpriseCost, MOCK_ENTERPRISE_COST } from '@/lib/finance/enterprise-cost';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

beforeEach(() => {
  cfg.anthropicAdminApiKey = '';
  cfg.financeEnterpriseMock = 'false';
});

afterEach(() => {
  vi.stubEnv('NODE_ENV', ORIGINAL_NODE_ENV ?? 'test');
  vi.unstubAllEnvs();
});

/** A canned raw Cost Report bucket set exercising every dimension. */
const CANNED_RESPONSE = {
  data: [
    {
      starting_at: '2026-07-01T00:00:00Z',
      ending_at: '2026-07-02T00:00:00Z',
      results: [
        {
          surface_label: 'Chat',
          model: 'claude-opus-4-6-20260115',
          cost_type: 'tokens',
          context_window: '0-200k',
          token_type: 'uncached_input_tokens',
          service_tier: 'standard',
          amount_usd: 10,
          token_count: 1000,
        },
        {
          surface_label: 'Code',
          model: 'claude-sonnet-5-20260115',
          cost_type: 'tokens',
          context_window: '200k-1M',
          token_type: 'cache_read_input_tokens',
          service_tier: 'priority',
          amount_usd: 5,
          token_count: 500,
        },
        {
          surface_label: 'Cowork',
          model: 'claude-haiku-4-5-20251001',
          cost_type: 'web_search',
          context_window: '0-200k',
          token_type: 'output_tokens',
          service_tier: 'standard',
          amount_usd: 2,
          token_count: 200,
        },
        {
          // no surface_label → falls into 'chat' per the graceful-degrade rule
          model: 'claude-sonnet-5-20260115',
          cost_type: 'code_execution',
          context_window: '0-200k',
          token_type: 'cache_creation_input_tokens',
          service_tier: 'batch',
          amount_usd: 1,
          token_count: 100,
        },
      ],
    },
  ],
};

describe('fetchEnterpriseCost', () => {
  it('maps a canned Enterprise Analytics response into EnterpriseCost', async () => {
    cfg.anthropicAdminApiKey = 'test-key';
    const fetchJson = vi.fn().mockResolvedValue(CANNED_RESPONSE);

    const result = await fetchEnterpriseCost('2026-07', { fetchJson });

    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
    const cost = result!;

    // per-surface $ — the unlabeled bucket (amount_usd=1) folds into chat.
    expect(cost.bySurface.chat.usd).toBe(11);
    expect(cost.bySurface.chat.tokens.input).toBe(1000);
    expect(cost.bySurface.chat.tokens.cacheWrite).toBe(100);

    expect(cost.bySurface.code.usd).toBe(5);
    expect(cost.bySurface.code.tokens.cacheRead).toBe(500);

    expect(cost.bySurface.cowork.usd).toBe(2);
    expect(cost.bySurface.cowork.tokens.output).toBe(200);

    // by-model
    expect(cost.byModel).toEqual(
      expect.arrayContaining([
        { model: 'claude-opus-4-6-20260115', usd: 10 },
        { model: 'claude-sonnet-5-20260115', usd: 6 }, // 5 (code) + 1 (unlabeled)
        { model: 'claude-haiku-4-5-20251001', usd: 2 },
      ])
    );

    // by cost_type
    expect(cost.byType).toEqual({ tokens: 15, webSearch: 2, codeExecution: 1 });

    // by context window
    expect(cost.contextWindow).toEqual({ standardUsd: 13, longUsd: 5 });

    // by token type (counts)
    expect(cost.tokenTypes).toEqual({
      uncachedInput: 1000,
      cachedInput: 500,
      cacheCreation: 100,
      output: 200,
    });

    // fast (priority) vs standard (standard + batch) mode
    expect(cost.fastModeUsd).toBe(5);
    expect(cost.standardModeUsd).toBe(13);
  });

  it('returns null when no Analytics API key is configured', async () => {
    cfg.anthropicAdminApiKey = '';
    const fetchJson = vi.fn();

    const result = await fetchEnterpriseCost('2026-07', { fetchJson });

    expect(result).toBeNull();
    expect(fetchJson).not.toHaveBeenCalled();
  });
});

describe('getEnterpriseCost selector', () => {
  it('resolves to live when an Analytics API key is set', async () => {
    cfg.anthropicAdminApiKey = 'test-key';
    const fetchJson = vi.fn().mockResolvedValue(CANNED_RESPONSE);

    const result = await getEnterpriseCost('2026-07', { fetchJson });

    expect(result.source).toBe('live');
    expect(result.data).not.toBeNull();
    expect(result.data!.bySurface.chat.usd).toBe(11);
  });

  it('resolves to mock when no key + flag on + non-production', async () => {
    cfg.anthropicAdminApiKey = '';
    cfg.financeEnterpriseMock = 'true';
    vi.stubEnv('NODE_ENV', 'development');

    const result = await getEnterpriseCost('2026-07');

    expect(result.source).toBe('mock');
    expect(result.data).toEqual(MOCK_ENTERPRISE_COST);
    expect(result.data!.bySurface.chat.usd).toBeGreaterThan(0);
  });

  it('resolves to none when no key + mock flag off', async () => {
    cfg.anthropicAdminApiKey = '';
    cfg.financeEnterpriseMock = 'false';

    const result = await getEnterpriseCost('2026-07');

    expect(result).toEqual({ data: null, source: 'none' });
  });

  it('resolves to none when mock flag on but NODE_ENV is production and no allow-mock env (production-safe)', async () => {
    cfg.anthropicAdminApiKey = '';
    cfg.financeEnterpriseMock = 'true';
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CCC_FINOPS_ALLOW_MOCK', '');

    const result = await getEnterpriseCost('2026-07');

    expect(result).toEqual({ data: null, source: 'none' });
  });

  it('resolves to mock in production ONLY when CCC_FINOPS_ALLOW_MOCK=1 is explicitly set (opt-in demo)', async () => {
    cfg.anthropicAdminApiKey = '';
    cfg.financeEnterpriseMock = 'true';
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CCC_FINOPS_ALLOW_MOCK', '1');

    const result = await getEnterpriseCost('2026-07');

    expect(result.source).toBe('mock');
    expect(result.data).toEqual(MOCK_ENTERPRISE_COST);
  });
});
