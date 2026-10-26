// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Anthropic Spend Limits client: minor-unit parsing (cents, fractional cents),
// null = unlimited, source labels, member grouping, pending-only requests,
// pagination and the HTTP-status → state mapping. fetch is stubbed; no network.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseMinorUnits, mapEffectiveRows, mapIncreaseRequests, primaryRow, shareUsed,
  fetchSpendLimits, sourceLabel, indexByEmail,
} from '@/lib/anthropic/spend-limits';

const actor = (id: string, email: string | null = `${id}@example.com`) =>
  ({ type: 'user_actor', user_id: id, email_address: email, name: id.toUpperCase(), deleted: false });

afterEach(() => vi.unstubAllGlobals());

describe('parseMinorUnits', () => {
  it('reads cents into dollars, including fractional cents', () => {
    expect(parseMinorUnits('50000')).toBe(500);
    expect(parseMinorUnits('41280.125')).toBeCloseTo(412.80125, 6);
    expect(parseMinorUnits('0')).toBe(0);
  });
  it('treats null, blank and garbage as unknown, never zero', () => {
    expect(parseMinorUnits(null)).toBeNull();
    expect(parseMinorUnits('')).toBeNull();
    expect(parseMinorUnits('abc')).toBeNull();
  });
});

describe('mapping', () => {
  it('groups rows by member, keeps unlimited as null and skips API-key actors', () => {
    const members = mapEffectiveRows([
      { actor: actor('user_a'), amount: '50000', currency: 'USD', period: 'monthly', period_to_date_spend: '31402.5', source: { type: 'seat_tier', seat_tier: 'enterprise_standard' } },
      { actor: actor('user_a'), amount: '5000', currency: 'USD', period: 'daily', period_to_date_spend: '100', source: { type: 'user' } },
      { actor: actor('user_b'), amount: null, currency: 'USD', period: 'monthly', period_to_date_spend: '9999', source: { type: 'organization' } },
      { actor: { type: 'scoped_api_key_actor' } as never, amount: '1', period: 'monthly', period_to_date_spend: '0' },
    ]);
    expect(members).toHaveLength(2);
    const a = members.find(m => m.anthropicUserId === 'user_a')!;
    expect(a.rows).toHaveLength(2);
    const monthly = primaryRow(a)!;
    expect(monthly.period).toBe('monthly');
    expect(monthly.limit).toBe(500);
    expect(monthly.spend).toBeCloseTo(314.025, 6);
    expect(monthly.source).toBe('Seat type default (enterprise standard)');
    expect(shareUsed(monthly)).toBeCloseTo(0.62805, 5);

    const b = primaryRow(members.find(m => m.anthropicUserId === 'user_b'))!;
    expect(b.limit).toBeNull();
    expect(shareUsed(b)).toBeNull();
  });

  it('reads a zero limit as used up', () => {
    expect(shareUsed({ period: 'monthly', limit: 0, spend: 0, currency: 'USD', source: '' })).toBe(1);
  });

  it('labels every documented source and falls through on unknown types', () => {
    expect(sourceLabel({ type: 'user' })).toBe('Set for this person');
    expect(sourceLabel({ type: 'rbac_group' })).toBe('Group default');
    expect(sourceLabel({ type: 'organization' })).toBe('Organisation default');
    expect(sourceLabel({ type: 'some_new_scope' })).toBe('some new scope');
  });

  it('keeps only pending requests and their live summary', () => {
    const reqs = mapIncreaseRequests([
      { id: 'slir_1', actor: actor('user_a'), created_at: '2026-09-30T10:00:00Z', period: 'monthly', status: 'pending', spend_summary: { amount: '50000', period_to_date_spend: '50000', currency: 'USD', period: 'monthly', source: { type: 'user' } } },
      { id: 'slir_2', actor: actor('user_b'), created_at: '2026-09-01T10:00:00Z', period: 'monthly', status: 'denied', spend_summary: null },
    ]);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].summary?.spend).toBe(500);
    const idx = indexByEmail({ status: 'ok', fetchedAt: 1, members: [], pendingRequests: reqs });
    expect(idx.requests.get('user_a@example.com')?.id).toBe('slir_1');
  });
});

describe('fetchSpendLimits', () => {
  it('follows next_page cursors and calls only the two read endpoints', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      const u = new URL(url);
      if (u.pathname.endsWith('/spend_limits/effective')) {
        const page = u.searchParams.get('page');
        return new Response(JSON.stringify(page
          ? { data: [{ actor: actor('user_b'), amount: '100', currency: 'USD', period: 'monthly', period_to_date_spend: '50', source: { type: 'user' } }], next_page: null }
          : { data: [{ actor: actor('user_a'), amount: '100', currency: 'USD', period: 'monthly', period_to_date_spend: '90', source: { type: 'user' } }], next_page: 'p2' }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [], next_page: null }), { status: 200 });
    }));
    const snap = await fetchSpendLimits('sk-test');
    expect(snap.status).toBe('ok');
    expect(snap.members.map(m => m.anthropicUserId).sort()).toEqual(['user_a', 'user_b']);
    expect(urls.every(u => u.includes('/spend_limits/effective') || u.includes('/spend_limit_increase_requests'))).toBe(true);
    expect(urls.some(u => u.includes('status%5B%5D=pending'))).toBe(true);
  });

  it.each([
    [401, 'invalid_key'],
    [403, 'missing_scope'],
    [404, 'not_available'],
    [500, 'error'],
  ])('maps HTTP %i to %s and never throws', async (status, expected) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status })));
    const snap = await fetchSpendLimits('sk-test');
    expect(snap.status).toBe(expected);
    expect(snap.members).toEqual([]);
  });
});
