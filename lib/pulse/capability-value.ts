// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Capability value attribution rollup. Pure/client-safe.
// These are MANAGER-ATTRIBUTED estimates, never modelled and NEVER summed with
// FinOps spend or the Developer Pulse value estimate. Hard rules encoded here:
//   - one-off savings are never annualised;
//   - time-reclaimed stays in hours and never enters the currency totals.

export type ValueType = 'external_spend_replaced' | 'cost_avoidance' | 'time_reclaimed';
export type ValuePeriod = 'one_off' | 'monthly' | 'annual';

export interface ValuedCapability {
  valueType: ValueType | null;
  valueAmount: number | null;
  valuePeriod: ValuePeriod | null;
}

export interface ValueRollup {
  /** £/yr from recurring currency attributions (monthly×12 + annual). */
  annualisedRecurring: number;
  /** £ from one-off currency attributions — shown separately, never annualised. */
  oneOffTotal: number;
  /** Hours per month reclaimed — kept in hours (currency only if finance sets a rate elsewhere). */
  hoursReclaimedMonthly: number;
  coverage: { valued: number; total: number };
}

const CURRENCY_TYPES: ValueType[] = ['external_spend_replaced', 'cost_avoidance'];

export function rollupCapabilityValue(caps: ValuedCapability[]): ValueRollup {
  let annualisedRecurring = 0;
  let oneOffTotal = 0;
  let hoursReclaimedMonthly = 0;
  let valued = 0;

  for (const c of caps) {
    if (c.valueAmount === null || c.valueAmount === undefined || c.valueType === null) continue;
    valued += 1;

    if (c.valueType === 'time_reclaimed') {
      // Hours per month; never converted to currency here.
      hoursReclaimedMonthly += c.valueAmount;
      continue;
    }

    if (CURRENCY_TYPES.includes(c.valueType)) {
      if (c.valuePeriod === 'monthly') annualisedRecurring += c.valueAmount * 12;
      else if (c.valuePeriod === 'annual') annualisedRecurring += c.valueAmount;
      else if (c.valuePeriod === 'one_off') oneOffTotal += c.valueAmount; // NEVER annualised
    }
  }

  return { annualisedRecurring, oneOffTotal, hoursReclaimedMonthly, coverage: { valued, total: caps.length } };
}
