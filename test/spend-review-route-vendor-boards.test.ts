// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// GET /api/finance/spend-review: the Claude and OpenAI efficiency boards fall
// back to last month each on its own (early in a month), through the cache;
// a Claude-only hub never builds last month for an OpenAI board it cannot have.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SpendReviewIndex, EfficiencyEntry } from '@/lib/finance/spend-review';

vi.mock('@/lib/config', () => ({ getAllConfig: async () => ({ chargebackEnabled: true }), getConfigValue: async () => undefined }));
vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return { ...actual, getAdminSession: async () => ({ authenticated: true, userId: 'a1', email: 'admin@test.local', role: 'admin' }) };
});
vi.mock('@/lib/audit/log', () => ({ logAccess: vi.fn() }));
vi.mock('@/lib/anthropic/spend-limits', async (orig) => {
  const actual = await orig<typeof import('@/lib/anthropic/spend-limits')>();
  return { ...actual, getSpendLimits: async () => ({ status: 'not_configured', fetchedAt: null, members: [], pendingRequests: [] }) };
});

const entry = (userId: string): EfficiencyEntry => ({ userId, displayName: userId, department: null, vsColleagues: 0.5, sessions: 12, deepRate: 0.5, peerDeepRate: 0.5 });
const indexes = new Map<string, Partial<SpendReviewIndex>>();
const buildMock = vi.fn(async (period: string) => ({
  period, openai: false, people: [], efficiency: [], efficiencyOpenai: [], unpricedModels: [],
  summary: { totalUsd: 0, priorTotalUsd: null, people: 0, halfSpendPeople: null, topWork: [], peopleWithRoutes: 0, orgRereadShare: null },
  ...indexes.get(period),
}) as SpendReviewIndex);
vi.mock('@/lib/finance/spend-review', async (orig) => {
  const actual = await orig<typeof import('@/lib/finance/spend-review')>();
  return { ...actual, buildSpendReviewIndex: buildMock };
});

const THIS = (() => { const d = new Date(); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; })();
const LAST = (() => { const d = new Date(); const p = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)); return `${p.getUTCFullYear()}-${String(p.getUTCMonth() + 1).padStart(2, '0')}`; })();

beforeEach(async () => {
  vi.resetModules();
  indexes.clear();
  buildMock.mockClear();
  (await import('@/lib/finance/spend-review-cache')).clearSpendReviewCache();
});

async function get() {
  const { GET } = await import('../app/api/finance/spend-review/route');
  return (await GET(new NextRequest('http://localhost/api/finance/spend-review'))).json();
}

describe('GET /api/finance/spend-review efficiency boards', () => {
  it('falls back to last month for the OpenAI board alone while this month has a Claude board', async () => {
    indexes.set(THIS, { openai: true, efficiency: [entry('claude-now')], efficiencyOpenai: [] });
    indexes.set(LAST, { openai: true, efficiency: [entry('claude-last')], efficiencyOpenai: [entry('openai-last')] });
    const body = await get();
    expect(body.efficiency.map((e: EfficiencyEntry) => e.userId)).toEqual(['claude-now']);
    expect(body.efficiencyPeriod).toBe(THIS);
    expect(body.efficiencyOpenai.map((e: EfficiencyEntry) => e.userId)).toEqual(['openai-last']);
    expect(body.efficiencyOpenaiPeriod).toBe(LAST);
  });

  it('keeps each board on this month when both have people', async () => {
    indexes.set(THIS, { openai: true, efficiency: [entry('c')], efficiencyOpenai: [entry('o')] });
    const body = await get();
    expect([body.efficiencyPeriod, body.efficiencyOpenaiPeriod]).toEqual([THIS, THIS]);
    expect(buildMock).toHaveBeenCalledTimes(1);
  });

  it('a Claude-only hub with a Claude board builds no extra month', async () => {
    indexes.set(THIS, { openai: false, efficiency: [entry('c')], efficiencyOpenai: [] });
    const body = await get();
    expect(body.efficiencyOpenai).toEqual([]);
    expect(buildMock).toHaveBeenCalledTimes(1);
  });
});
