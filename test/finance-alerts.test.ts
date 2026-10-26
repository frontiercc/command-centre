// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import { jsonText, type TestSql } from './helpers/sql';
import type { SurfaceSummary, CodeTokens } from '@/lib/finance/chargeback';
import type { EnterpriseCost } from '@/lib/finance/enterprise-cost';

let sql: TestSql;
let cleanup: () => Promise<void>;

// Fixed point in time (not Date.now()) so the period derived by currentPeriod()
// is deterministic regardless of when the suite actually runs.
const NOW = Math.floor(Date.UTC(2026, 6, 15) / 1000); // 2026-07-15 UTC
const PERIOD = '2026-07';

// Mutable config stub — mirrors the getAllConfig().chargebackEnabled /
// getConfigValue('financeDriftAlertThresholdPct') calls the module makes.
const cfg: { chargebackEnabled: boolean; financeDriftAlertThresholdPct: string } = {
  chargebackEnabled: true,
  financeDriftAlertThresholdPct: '10',
};
vi.mock('@/lib/config', () => ({
  getAllConfig: () => ({ chargebackEnabled: cfg.chargebackEnabled }),
  getConfigValue: (key: string) => (key === 'financeDriftAlertThresholdPct' ? cfg.financeDriftAlertThresholdPct : ''),
}));

function tokens(): CodeTokens {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
}

// Mutable chargeback report stub — only `.surfaces` is read by buildReconciliation.
let surfaces: SurfaceSummary = {
  chat: { usd: null, tokens: tokens(), basis: 'dormant' },
  code: { usd: 100, tokens: tokens(), basis: 'estimate' },
  cowork: { usd: 0, tokens: tokens(), basis: 'actual' },
  total: { usd: 100, tokens: tokens() },
};
vi.mock('@/lib/finance/chargeback', () => ({
  buildChargeback: () => ({ surfaces }),
}));

// Mutable enterprise-cost stub — null `data` simulates "unavailable" (no key / no live tenant).
let enterpriseData: EnterpriseCost | null = {
  bySurface: {
    chat: { usd: 0, tokens: tokens() },
    code: { usd: 100, tokens: tokens() },
    cowork: { usd: 0, tokens: tokens() },
  },
  byModel: [],
  byType: { tokens: 0, webSearch: 0, codeExecution: 0 },
  contextWindow: { standardUsd: 0, longUsd: 0 },
  tokenTypes: { uncachedInput: 0, cachedInput: 0, cacheCreation: 0, output: 0 },
  fastModeUsd: 0,
  standardModeUsd: 0,
};
vi.mock('@/lib/finance/enterprise-cost', () => ({
  getEnterpriseCost: async () => ({ data: enterpriseData, source: enterpriseData ? 'mock' : 'none' }),
}));

let runFinanceDriftAlert: typeof import('@/lib/alerts/finance-alerts').runFinanceDriftAlert;

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
  const mod = await import('@/lib/alerts/finance-alerts');
  runFinanceDriftAlert = mod.runFinanceDriftAlert;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`DELETE FROM alerts;`);
  cfg.chargebackEnabled = true;
  cfg.financeDriftAlertThresholdPct = '10';
  surfaces = {
    chat: { usd: null, tokens: tokens(), basis: 'dormant' },
    code: { usd: 100, tokens: tokens(), basis: 'estimate' },
    cowork: { usd: 0, tokens: tokens(), basis: 'actual' },
    total: { usd: 100, tokens: tokens() },
  };
  enterpriseData = {
    bySurface: {
      chat: { usd: 0, tokens: tokens() },
      code: { usd: 100, tokens: tokens() },
      cowork: { usd: 0, tokens: tokens() },
    },
    byModel: [],
    byType: { tokens: 0, webSearch: 0, codeExecution: 0 },
    contextWindow: { standardUsd: 0, longUsd: 0 },
    tokenTypes: { uncachedInput: 0, cachedInput: 0, cacheCreation: 0, output: 0 },
    fastModeUsd: 0,
    standardModeUsd: 0,
  };
});

async function countAlerts(): Promise<number> {
  return ((await sql.get(`SELECT COUNT(*) c FROM alerts WHERE alert_type = 'finance_reconciliation_drift'`)) as { c: number }).c;
}

describe('runFinanceDriftAlert', () => {
  it('raises one alert when drift exceeds the threshold', async () => {
    // ccc code=130 vs anthropic code=100 → totalDeltaPct = 30% > 10% threshold.
    surfaces.code.usd = 130;
    surfaces.total.usd = 130;

    await runFinanceDriftAlert(NOW);

    expect(await countAlerts()).toBe(1);
    const row = (await sql.get(`SELECT * FROM alerts WHERE alert_type = 'finance_reconciliation_drift'`)) as Record<string, string>;
    expect(row.severity).toBe('high'); // 30% >= 2×10% threshold
    expect(row.title).toContain('30.0%');
    expect(row.title).toContain(PERIOD);
    expect(jsonText(row.raw_evidence)).toContain('"source":"finops"');
    expect(jsonText(row.raw_evidence)).toContain(PERIOD);
  });

  it('dedupes — a second run with the same NOW does not re-fire', async () => {
    surfaces.code.usd = 130;
    surfaces.total.usd = 130;

    await runFinanceDriftAlert(NOW);
    await runFinanceDriftAlert(NOW);

    expect(await countAlerts()).toBe(1);
  });

  it('dedupes within the 7-day window — 3 days after an alert still does not re-fire', async () => {
    surfaces.code.usd = 130;
    surfaces.total.usd = 130;

    // Insert a prior alert 3 days in the past
    const threeDaysAgo = NOW - 3 * 24 * 3600;
    await sql.run(
      `INSERT INTO alerts (id, alert_type, severity, title, explanation, raw_evidence, generated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
      'prior-alert-id',
      'finance_reconciliation_drift',
      'medium',
      'Prior alert',
      'Prior explanation',
      JSON.stringify({ source: 'finops', period: '2026-07', totalDeltaPct: 30, threshold: 10 }),
      threeDaysAgo],
    );

    // Calling with NOW (3 days later) should still dedup
    await runFinanceDriftAlert(NOW);

    expect(await countAlerts()).toBe(1);
  });

  it('fires a new alert when 8 days have passed since the prior alert', async () => {
    surfaces.code.usd = 130;
    surfaces.total.usd = 130;

    // Insert a prior alert 8 days in the past
    const eightDaysAgo = NOW - 8 * 24 * 3600;
    await sql.run(
      `INSERT INTO alerts (id, alert_type, severity, title, explanation, raw_evidence, generated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
      'prior-alert-id',
      'finance_reconciliation_drift',
      'medium',
      'Prior alert',
      'Prior explanation',
      JSON.stringify({ source: 'finops', period: '2026-07', totalDeltaPct: 30, threshold: 10 }),
      eightDaysAgo],
    );

    // Calling with NOW (8 days later) should fire a new alert (outside the 7-day window)
    await runFinanceDriftAlert(NOW);

    expect(await countAlerts()).toBe(2);
  });

  it('does not fire when drift is below the threshold', async () => {
    // ccc code=105 vs anthropic code=100 → 5% < 10% threshold.
    surfaces.code.usd = 105;
    surfaces.total.usd = 105;

    await runFinanceDriftAlert(NOW);

    expect(await countAlerts()).toBe(0);
  });

  it('does not fire when reconciliation is unavailable (no Analytics key/data)', async () => {
    surfaces.code.usd = 130;
    surfaces.total.usd = 130;
    enterpriseData = null;

    await runFinanceDriftAlert(NOW);

    expect(await countAlerts()).toBe(0);
  });

  it('does not fire when chargebackEnabled is off', async () => {
    cfg.chargebackEnabled = false;
    surfaces.code.usd = 130;
    surfaces.total.usd = 130;

    await runFinanceDriftAlert(NOW);

    expect(await countAlerts()).toBe(0);
  });

  it('uses medium severity when drift exceeds but is under 2x the threshold', async () => {
    // ccc code=115 vs anthropic code=100 → 15% > 10% threshold but < 20% (2x).
    surfaces.code.usd = 115;
    surfaces.total.usd = 115;

    await runFinanceDriftAlert(NOW);

    const row = (await sql.get(`SELECT severity FROM alerts WHERE alert_type = 'finance_reconciliation_drift'`)) as { severity: string };
    expect(row.severity).toBe('medium');
  });
});
