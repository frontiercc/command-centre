// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Covers the pure renderer for the report's Cost & Chargeback section. The
// point of these tests is the honesty rules, not the prose: null must never
// render as $0, unpriced models must be called out rather than silently
// dropped, estimated spend must be labelled, and a report window spanning two
// calendar months must say which month the figures actually cover.
import { describe, it, expect } from 'vitest';
import { monthOf, periodMatchesMonth, renderFinopsSection } from '@/lib/reports/finops-sections';
import type { ChargebackReport } from '@/lib/finance/chargeback';
import type { ModelEfficiencyReport } from '@/lib/finance/model-efficiency';

const zeroTokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

function report(over: Partial<ChargebackReport> = {}): ChargebackReport {
  return {
    period: '2026-07',
    periodStart: 0,
    periodEnd: 0,
    monthToDate: false,
    status: 'open',
    closedAt: null,
    grandTotalUsd: 100,
    estimated: false,
    unpricedModels: [],
    coworkCostCoverage: { withCost: 10, total: 10 },
    codeTokens: zeroTokens,
    cacheSavingsUsd: 5,
    costCentres: [{ name: 'Engineering', code: 'GL-100', totalUsd: 80, codeUsd: 60, coworkUsd: 20, users: [] }],
    unallocated: { totalUsd: 20, users: [] },
    surfaces: {
      chat: { usd: null, tokens: zeroTokens, basis: 'dormant' },
      code: { usd: 60, tokens: { ...zeroTokens, input: 1000 }, basis: 'actual' },
      cowork: { usd: 40, tokens: { ...zeroTokens, input: 500 }, basis: 'actual' },
      total: { usd: 100, tokens: { ...zeroTokens, input: 1500 } },
    },
    leaderboard: [],
    ...over,
  } as unknown as ChargebackReport;
}

function eff(over: Partial<ModelEfficiencyReport> = {}): ModelEfficiencyReport {
  return {
    surface: 'code',
    enabled: true,
    hasData: true,
    period: { start: 0, end: 0 },
    totals: { spendUsd: 60, tokens: 1000 },
    activities: [],
    unpricedModels: [],
    belowVolume: [],
    modelOrder: [],
    cacheEfficiency: { ratio: 0.65, cacheReadTokens: 650, inputSideTokens: 1000 },
    spendByModel: [{ model: 'claude-opus-5', spendUsd: 60, tokens: 1000, tier: 'premium' }],
    costByType: { inputUsd: 20, outputUsd: 30, cacheWriteUsd: 5, cacheReadUsd: 5, unclassifiedUsd: 0 },
    ...over,
  } as unknown as ModelEfficiencyReport;
}

const render = (r = report(), c = eff(), w = eff({ surface: 'cowork' }), start = '2026-07-01', end = '2026-07-31') =>
  renderFinopsSection(r, c, w, start, end);

describe('monthOf / periodMatchesMonth', () => {
  it('resolves the calendar month of an ISO date', () => {
    expect(monthOf('2026-07-27')).toBe('2026-07');
    expect(monthOf('2026-01-05')).toBe('2026-01');
  });

  it('detects a window that crosses a month boundary', () => {
    expect(periodMatchesMonth('2026-07-01', '2026-07-31')).toBe(true);
    expect(periodMatchesMonth('2026-06-28', '2026-07-05')).toBe(false);
  });
});

describe('renderFinopsSection', () => {
  it('states the month plainly when the window sits inside one month', () => {
    expect(render()).toContain('Figures cover the calendar month **2026-07**');
  });

  it('warns when the report window spans more than one month', () => {
    const md = render(report(), eff(), eff(), '2026-06-28', '2026-07-05');
    expect(md).toContain('spans more than one calendar month');
    expect(md).toContain('**2026-07**');
  });

  it('renders a dormant surface as not captured, never as $0', () => {
    const md = render();
    expect(md).toContain('| Chat | not captured on this deployment | — |');
    expect(md).not.toContain('| Chat | $0.00');
  });

  it('labels estimated spend and explains why', () => {
    const md = render(report({ estimated: true }));
    expect(md).toContain('partly estimated');
    expect(md).toContain('list rates');
  });

  it('names unpriced models and says they are excluded rather than zeroed', () => {
    const md = render(report({ unpricedModels: ['some-unknown-model'] }));
    expect(md).toContain('some-unknown-model');
    expect(md).toContain('excluded from spend rather than counted as zero');
  });

  it('reports a null cache saving as not measured', () => {
    expect(render(report({ cacheSavingsUsd: null }))).toContain('Cache savings this period: not measured');
  });

  it('flags a partial cowork cost coverage gap', () => {
    const md = render(report({ coworkCostCoverage: { withCost: 4, total: 10 } }));
    expect(md).toContain('4 of 10 records');
  });

  it('marks a closed period as an immutable snapshot', () => {
    const md = render(report({ status: 'closed', closedAt: 123 }));
    expect(md).toContain('immutable snapshot');
  });

  it('says month-to-date figures will rise', () => {
    expect(render(report({ monthToDate: true }))).toContain('month-to-date and will rise');
  });

  it('falls back to a clear message when no cost centres are configured', () => {
    const md = render(report({ costCentres: [] }));
    expect(md).toContain('No cost centres are configured');
  });

  it('renders cost centre rows with GL codes and the unallocated bucket', () => {
    const md = render();
    expect(md).toContain('| Engineering | GL-100 | $80.00 | $60.00 | $20.00 |');
    expect(md).toContain('Unallocated');
    expect(md).toContain('$20.00');
  });

  it('reports cache efficiency as a percentage', () => {
    expect(render()).toContain('65% of input-side tokens served from cache');
  });

  it('says so when a surface has no priced activity', () => {
    const md = render(report(), eff({ hasData: false }));
    expect(md).toContain('no priced activity in this period');
  });

  it('states no caveats apply when the data is clean', () => {
    expect(render()).toContain('No pricing gaps or coverage caveats apply');
  });
});
