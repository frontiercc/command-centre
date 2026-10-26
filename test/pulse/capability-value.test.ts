// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Capability value attribution rollup (metric-refinements §3). Pure. The load-
// bearing rule: one-off savings are NEVER annualised, and time-reclaimed stays
// in hours (never silently dollarised).
import { describe, it, expect } from 'vitest';
import { rollupCapabilityValue, type ValuedCapability } from '@/lib/pulse/capability-value';

describe('rollupCapabilityValue (§3b)', () => {
  it('annualises recurring currency values, keeps one-offs separate, hours in hours', () => {
    const caps: ValuedCapability[] = [
      { valueType: 'external_spend_replaced', valueAmount: 1200, valuePeriod: 'monthly' }, // ×12 = 14400
      { valueType: 'cost_avoidance', valueAmount: 5000, valuePeriod: 'annual' },            // 5000
      { valueType: 'external_spend_replaced', valueAmount: 2000, valuePeriod: 'one_off' },  // one-off, NOT annualised
      { valueType: 'time_reclaimed', valueAmount: 10, valuePeriod: 'monthly' },             // 10 hours/month
      { valueType: null, valueAmount: null, valuePeriod: null },                            // unvalued
    ];
    const r = rollupCapabilityValue(caps);
    expect(r.annualisedRecurring).toBeCloseTo(14400 + 5000, 5);
    expect(r.oneOffTotal).toBeCloseTo(2000, 5);
    expect(r.hoursReclaimedMonthly).toBeCloseTo(10, 5);
    expect(r.coverage).toEqual({ valued: 4, total: 5 });
  });

  it('never folds a one-off into the annualised figure', () => {
    const r = rollupCapabilityValue([{ valueType: 'cost_avoidance', valueAmount: 9999, valuePeriod: 'one_off' }]);
    expect(r.annualisedRecurring).toBe(0);
    expect(r.oneOffTotal).toBeCloseTo(9999, 5);
  });

  it('keeps time-reclaimed out of the currency totals entirely', () => {
    const r = rollupCapabilityValue([{ valueType: 'time_reclaimed', valueAmount: 40, valuePeriod: 'monthly' }]);
    expect(r.annualisedRecurring).toBe(0);
    expect(r.oneOffTotal).toBe(0);
    expect(r.hoursReclaimedMonthly).toBeCloseTo(40, 5);
  });

  it('zero-guards an empty set', () => {
    const r = rollupCapabilityValue([]);
    expect(r).toEqual({ annualisedRecurring: 0, oneOffTotal: 0, hoursReclaimedMonthly: 0, coverage: { valued: 0, total: 0 } });
  });
});
