// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const configMock = vi.hoisted(() => ({ getConfigValue: vi.fn() }));
vi.mock('@/lib/config', () => configMock);

import { getDxFramework, MOCK_DX_FRAMEWORK } from '@/lib/pulse/code/dx-framework';

describe('getDxFramework', () => {
  const origEnv = process.env.NODE_ENV;
  const origAllow = process.env.CCC_DX_ALLOW_MOCK;
  beforeEach(() => configMock.getConfigValue.mockReset());
  afterEach(() => {
    (process.env as any).NODE_ENV = origEnv;
    process.env.CCC_DX_ALLOW_MOCK = origAllow;
  });

  it('returns none when no key and mock is off', async () => {
    configMock.getConfigValue.mockResolvedValue('');
    const r = await getDxFramework();
    expect(r).toEqual({ data: null, source: 'none' });
  });

  it('returns mock when mock=true and not production', async () => {
    (process.env as any).NODE_ENV = 'test';
    configMock.getConfigValue.mockImplementation(async (k: string) =>
      k === 'dxFrameworkMock' ? 'true' : '');
    const r = await getDxFramework();
    expect(r.source).toBe('mock');
    expect(r.data).toEqual(MOCK_DX_FRAMEWORK);
  });

  it('blocks the mock in production unless CCC_DX_ALLOW_MOCK=1', async () => {
    (process.env as any).NODE_ENV = 'production';
    delete process.env.CCC_DX_ALLOW_MOCK;
    configMock.getConfigValue.mockImplementation(async (k: string) =>
      k === 'dxFrameworkMock' ? 'true' : '');
    expect((await getDxFramework()).source).toBe('none');
    process.env.CCC_DX_ALLOW_MOCK = '1';
    expect((await getDxFramework()).source).toBe('mock');
  });

  it('prefers live when an api key is set, using injected fetchLive', async () => {
    configMock.getConfigValue.mockImplementation(async (k: string) =>
      k === 'dxApiKey' ? 'tok_live' : '');
    const r = await getDxFramework({ fetchLive: async () => MOCK_DX_FRAMEWORK });
    expect(r.source).toBe('live');
    expect(r.data).toEqual(MOCK_DX_FRAMEWORK);
  });
});
