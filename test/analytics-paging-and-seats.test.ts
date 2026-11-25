// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The Analytics API's paging rule and FinOps' choice of seat count.
// nextAnalyticsPage: the live API sends no `has_more`, only `next_page`, so
// paging must follow `next_page` alone or every day stops after 100 people.
// resolveLicensedSeats: the seat count typed in Admin wins; otherwise the one
// Anthropic reports; otherwise none.
import { describe, it, expect, vi } from 'vitest';
import { nextAnalyticsPage } from '@/lib/anthropic/analytics';
import { resolveLicensedSeats } from '@/lib/finance/seats';

vi.mock('@/lib/db/client', () => ({ getTypedClient: vi.fn() }));
vi.mock('@/lib/config', () => ({ getConfigValue: vi.fn(), setConfigValue: vi.fn(), getAllConfig: vi.fn() }));
vi.mock('@/lib/ingestion/scheduler', () => ({ withBackoff: (fn: () => unknown) => fn() }));


describe('nextAnalyticsPage', () => {
  it('follows next_page when has_more is absent (the live shape)', () => {
    expect(nextAnalyticsPage({ next_page: 'cursor-2' })).toBe('cursor-2');
  });

  it('stops when next_page is null, missing or empty', () => {
    expect(nextAnalyticsPage({ next_page: null })).toBeUndefined();
    expect(nextAnalyticsPage({})).toBeUndefined();
    expect(nextAnalyticsPage({ next_page: '' })).toBeUndefined();
  });

  it('stops on an explicit has_more: false even with a cursor', () => {
    expect(nextAnalyticsPage({ has_more: false, next_page: 'cursor-2' })).toBeUndefined();
  });

  it('follows the cursor when has_more is true', () => {
    expect(nextAnalyticsPage({ has_more: true, next_page: 'cursor-2' })).toBe('cursor-2');
  });
});

describe('resolveLicensedSeats', () => {
  it('uses the seat count typed in Admin when it is set', () => {
    expect(resolveLicensedSeats('150', '10')).toBe(150);
  });

  it("uses Anthropic's seat count when none is typed", () => {
    expect(resolveLicensedSeats('', '10')).toBe(10);
    expect(resolveLicensedSeats(undefined, '10')).toBe(10);
  });

  it('ignores a typed value that is not a positive number', () => {
    expect(resolveLicensedSeats('0', '10')).toBe(10);
    expect(resolveLicensedSeats('abc', '10')).toBe(10);
  });

  it('returns null when neither is usable', () => {
    expect(resolveLicensedSeats('', '')).toBeNull();
    expect(resolveLicensedSeats(undefined, '0')).toBeNull();
  });
});
