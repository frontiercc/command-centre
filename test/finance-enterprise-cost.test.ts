// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mutable config stub — each test sets the values it needs before importing.
const cfg: Record<string, string> = {};
vi.mock('@/lib/config', () => ({
  getConfigValue: (key: string) => cfg[key] ?? '',
}));

import { fetchEnterpriseCost, getEnterpriseCost, periodRange, MOCK_ENTERPRISE_COST } from '@/lib/finance/enterprise-cost';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const NOW = new Date('2026-11-25T18:00:00Z');

beforeEach(() => {
  cfg.anthropicAnalyticsApiKey = '';
  cfg.anthropicAdminApiKey = '';
  cfg.financeEnterpriseMock = 'false';
});

afterEach(() => {
  vi.stubEnv('NODE_ENV', ORIGINAL_NODE_ENV ?? 'test');
  vi.unstubAllEnvs();
});

/** Rows in the live shape of GET /v1/organizations/analytics/cost: amounts are cents as decimal strings. */
function row(group: Record<string, string | null>, cents: string) {
  return { group, cost: { amount: cents, currency: 'USD', list_amount: cents, requests: 1 } };
}

const PAGE_1 = {
  data: [
    row({ product: 'chat', model: 'claude-opus-5-5', context_window: '0-200k', speed: 'standard', cost_type: 'tokens', token_type: 'uncached_input_tokens' }, '1000'),
    row({ product: 'claude_code', model: 'claude-sonnet-5', context_window: '200k-1M', speed: 'fast', cost_type: 'tokens', token_type: 'cache_read_input_tokens' }, '500'),
    row({ product: 'cowork', model: 'claude-haiku-4-5-20251001', context_window: null, speed: null, cost_type: 'web_search', token_type: null }, '200'),
  ],
  has_more: true,
  next_page: 'page-2',
  data_refreshed_at: '2026-11-25T17:54:22Z',
};

const PAGE_2 = {
  data: [
    row({ product: 'cowork', model: 'claude-sonnet-5', context_window: '0-200k', speed: 'standard', cost_type: 'tokens', token_type: 'cache_creation.ephemeral_1h_input_tokens' }, '300'),
    // A product Command Centre has no surface for: counted in otherUsd and the breakdowns only.
    row({ product: 'claude_design', model: 'claude-sonnet-5', context_window: '0-200k', speed: 'standard', cost_type: 'tokens', token_type: 'output_tokens' }, '100'),
    row({ product: 'cowork', model: null, context_window: null, speed: null, cost_type: 'session_usage', token_type: null }, '50'),
  ],
  has_more: false,
  next_page: null,
};

describe('fetchEnterpriseCost', () => {
  it('reads every page and maps cents to dollars by product, model and type', async () => {
    cfg.anthropicAnalyticsApiKey = 'analytics-key';
    const fetchJson = vi.fn(async (url: string) => (url.includes('page=page-2') ? PAGE_2 : PAGE_1));

    const cost = (await fetchEnterpriseCost('2026-11', { fetchJson, now: NOW }))!;

    expect(fetchJson).toHaveBeenCalledTimes(2);
    const first = new URL(fetchJson.mock.calls[0][0]);
    expect(first.pathname).toBe('/v1/organizations/analytics/cost');
    expect(first.searchParams.get('starting_at')).toBe('2026-11-01T00:00:00Z');
    expect(first.searchParams.get('ending_at')).toBe('2026-11-25T18:00:00Z');
    // Only the group_by values the endpoint accepts (the old cost report rejected `model`).
    expect(first.searchParams.getAll('group_by[]')).toEqual(['product', 'model', 'context_window', 'speed', 'cost_type', 'token_type']);
    expect(new URL(fetchJson.mock.calls[1][0]).searchParams.get('page')).toBe('page-2');

    expect(cost.bySurface).toEqual({ chat: { usd: 10 }, code: { usd: 5 }, cowork: { usd: 5.5 } });
    expect(cost.otherUsd).toBe(1);

    expect(cost.byModel).toEqual([
      { model: 'claude-opus-5-5', usd: 10 },
      { model: 'claude-sonnet-5', usd: 9 },
      { model: 'claude-haiku-4-5-20251001', usd: 2 },
    ]);
    expect(cost.byType).toEqual({ tokens: 19, webSearch: 2, codeExecution: 0, sessionUsage: 0.5 });
    expect(cost.contextWindow).toEqual({ standardUsd: 14, longUsd: 5 });
    expect(cost.tokenTypeUsd).toEqual({ uncachedInput: 10, cachedInput: 5, cacheCreation: 3, output: 1 });
    expect(cost.fastModeUsd).toBe(5);
    expect(cost.standardModeUsd).toBe(16.5);
  });

  it('falls back to the Admin API key when no Analytics API key is set', async () => {
    cfg.anthropicAdminApiKey = 'admin-key';
    const fetchJson = vi.fn(async () => PAGE_2);

    const cost = await fetchEnterpriseCost('2026-11', { fetchJson, now: NOW });

    expect(cost).not.toBeNull();
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });

  it('returns null without calling Anthropic when neither key is set', async () => {
    const fetchJson = vi.fn();

    const result = await fetchEnterpriseCost('2026-11', { fetchJson, now: NOW });

    expect(result).toBeNull();
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it('stops when a page repeats its cursor', async () => {
    cfg.anthropicAnalyticsApiKey = 'analytics-key';
    const fetchJson = vi.fn(async () => ({ ...PAGE_1, next_page: 'same' }));

    await fetchEnterpriseCost('2026-11', { fetchJson, now: NOW });

    expect(fetchJson).toHaveBeenCalledTimes(2);
  });
});

describe('periodRange', () => {
  it('covers a past month in full', () => {
    expect(periodRange('2026-10', NOW)).toEqual({ startingAt: '2026-10-01T00:00:00Z', endingAt: '2026-11-01T00:00:00Z' });
  });

  it('ends a month in progress at now', () => {
    expect(periodRange('2026-11', NOW)).toEqual({ startingAt: '2026-11-01T00:00:00Z', endingAt: '2026-11-25T18:00:00Z' });
  });

  it('is null for a month not yet started or a malformed period', () => {
    expect(periodRange('2026-12', NOW)).toBeNull();
    expect(periodRange('November', NOW)).toBeNull();
  });
});

describe('getEnterpriseCost selector', () => {
  it('resolves to live when an Analytics API key is set', async () => {
    cfg.anthropicAnalyticsApiKey = 'analytics-key';
    const fetchJson = vi.fn(async () => PAGE_2);

    const result = await getEnterpriseCost('2026-11', { fetchJson, now: NOW });

    expect(result.source).toBe('live');
    expect(result.data!.bySurface.cowork.usd).toBe(3.5);
  });

  it('resolves to mock when no key + flag on + non-production', async () => {
    cfg.financeEnterpriseMock = 'true';
    vi.stubEnv('NODE_ENV', 'development');

    const result = await getEnterpriseCost('2026-07');

    expect(result.source).toBe('mock');
    expect(result.data).toEqual(MOCK_ENTERPRISE_COST);
    expect(result.data!.bySurface.chat.usd).toBeGreaterThan(0);
  });

  it('resolves to none when no key + mock flag off', async () => {
    const result = await getEnterpriseCost('2026-07');

    expect(result).toEqual({ data: null, source: 'none' });
  });

  it('resolves to none when mock flag on but NODE_ENV is production and no allow-mock env (production-safe)', async () => {
    cfg.financeEnterpriseMock = 'true';
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CCC_FINOPS_ALLOW_MOCK', '');

    const result = await getEnterpriseCost('2026-07');

    expect(result).toEqual({ data: null, source: 'none' });
  });

  it('resolves to mock in production ONLY when CCC_FINOPS_ALLOW_MOCK=1 is explicitly set (opt-in demo)', async () => {
    cfg.financeEnterpriseMock = 'true';
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CCC_FINOPS_ALLOW_MOCK', '1');

    const result = await getEnterpriseCost('2026-07');

    expect(result.source).toBe('mock');
    expect(result.data).toEqual(MOCK_ENTERPRISE_COST);
  });

  it('keeps the mock fixture internally consistent', () => {
    const m = MOCK_ENTERPRISE_COST;
    const total = m.bySurface.chat.usd + m.bySurface.code.usd + m.bySurface.cowork.usd + m.otherUsd;
    expect(m.byModel.reduce((s, x) => s + x.usd, 0)).toBeCloseTo(total, 6);
    expect(m.byType.tokens + m.byType.webSearch + m.byType.codeExecution + m.byType.sessionUsage).toBeCloseTo(total, 6);
    expect(m.contextWindow.standardUsd + m.contextWindow.longUsd).toBeCloseTo(total, 6);
    expect(m.fastModeUsd + m.standardModeUsd).toBeCloseTo(total, 6);
    const t = m.tokenTypeUsd;
    expect(t.uncachedInput + t.cachedInput + t.cacheCreation + t.output).toBeCloseTo(m.byType.tokens, 6);
  });
});
