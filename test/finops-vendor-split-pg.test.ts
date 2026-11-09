// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// FinOps split by product and vendor, on Postgres:
// - the 12-month trend carries each month's spend by product, and the parts
//   add up to that month's FinOps headline (grandTotalUsd);
// - a closed month frozen before ChatGPT and Codex counts as Claude, split
//   into Code and Cowork when the snapshot has them, else one Claude part;
// - with ChatGPT and Codex hidden, open months carry no OpenAI part;
// - the month-end projection splits into Claude and OpenAI, each projected
//   from its own month-to-date spend, adding up to the total projection;
// - the concentration tiers split into products adding up to each share.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

vi.mock('@/lib/config', async (orig) => {
  const actual = await orig<typeof import('@/lib/config')>();
  return { ...actual, getAllConfig: async () => ({ ...(await actual.getAllConfig()), chargebackEnabled: true }) };
});
vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return { ...actual, getAdminSession: async () => ({ authenticated: true, userId: 'a1', email: 'admin@test.local', role: 'admin' }) };
});
vi.mock('@/lib/audit/log', () => ({ logAccess: vi.fn() }));

let sql: TestSql;
let cleanup: () => Promise<void>;

const SEED_NOW = Math.floor(Date.now() / 1000);
const at = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d, 12) / 1000);
// "Now" is 20 March 2026: day 20 of 31, past the projection's seven-day floor.
const NOW = at(2026, 3, 20);
const DEPTS = ['Legal', 'Sales', 'Ops', 'Finance', 'People', 'Product'];

let n = 0;
async function claudeCode(user: string, when: number, usd: number) {
  // claude-haiku-4-5 at $1 per million input tokens.
  await sql.run(
    `INSERT INTO code_assistant_meta (id, session_id, user_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, occurred_at)
     VALUES (?, ?, ?, 'claude-haiku-4-5', ?, 0, 0, 0, ?)`, [`cam-${++n}`, `s-${n}`, user, Math.round(usd * 1_000_000), when]);
}
async function cowork(user: string, when: number, usd: number) {
  await sql.run(
    `INSERT INTO cowork_messages (id, session_id, user_id, message_type, model, cost_usd, occurred_at, surface)
     VALUES (?, ?, ?, 'cowork_api_request', 'claude-sonnet-4-6', ?, ?, 'cowork')`, [`cw-${++n}`, `cws-${n}`, user, String(usd), when]);
}
async function chatgpt(user: string, when: number, usd: number) {
  // gpt-6.1-terra at $1 per million input tokens.
  await sql.run(
    `INSERT INTO openai_costs (id, user_id, hour_start, product, model, input_tokens, cached_input_tokens, output_tokens, cost_usd, billed_in)
     VALUES (?, ?, ?, 'chatgpt', 'gpt-6.1-terra', ?, 0, 0, 0, 'usd')`, [`oc-${++n}`, user, when, Math.round(usd * 1_000_000)]);
}
async function codex(user: string, when: number, usd: number) {
  // gpt-6.1-terra at $5 per million output tokens.
  await sql.run(
    `INSERT INTO codex_turns (id, user_id, session_id, model, started_at, uncached_input_tokens, cached_input_tokens, output_tokens)
     VALUES (?, ?, ?, 'gpt-6.1-terra', ?, 0, 0, ?)`, [`ct-${++n}`, user, `codex:s${n}`, when, Math.round(usd * 200_000)]);
}

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
  for (const [i, dept] of DEPTS.entries()) {
    await sql.run(
      `INSERT INTO users (id, email, display_name, source, department, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'otel', ?, ?, ?)`,
      [`u${i}`, `u${i}@test.local`, `User ${i}`, dept, SEED_NOW, SEED_NOW]);
  }
  // January and February: Claude only. March: all four products across six cost centres.
  await claudeCode('u0', at(2026, 1, 10), 2);
  await cowork('u1', at(2026, 1, 11), 1);
  await claudeCode('u0', at(2026, 2, 10), 3);
  await claudeCode('u0', at(2026, 3, 5), 10);
  await chatgpt('u0', at(2026, 3, 6), 4);
  await cowork('u1', at(2026, 3, 7), 5);
  await codex('u2', at(2026, 3, 8), 4);
  await claudeCode('u3', at(2026, 3, 9), 3);
  await cowork('u4', at(2026, 3, 9), 1);
  await chatgpt('u4', at(2026, 3, 9), 1);
  await codex('u5', at(2026, 3, 10), 0.5);
});

afterAll(async () => cleanup());

describe('FinOps split by product', () => {
  it('each trend month carries its spend by product, adding up to the FinOps headline', async () => {
    const { buildSpendTrend } = await import('@/lib/finance/trend');
    const { buildChargeback } = await import('@/lib/finance/chargeback');
    const { partsTotal } = await import('@/lib/finance/product-split');
    const trend = await buildSpendTrend(NOW, 12);
    expect(trend.render).toBe(true);
    for (const p of trend.series) {
      const headline = (await buildChargeback(p.period, NOW)).grandTotalUsd;
      expect(p.usd).toBeCloseTo(headline, 9);
      expect(partsTotal(p.parts)).toBeCloseTo(headline, 9);
    }
    const byPeriod = new Map(trend.series.map(p => [p.period, p.parts]));
    expect(byPeriod.get('2026-01')).toEqual({ claude_code: expect.closeTo(2, 9), claude_cowork: 1 });
    expect(byPeriod.get('2026-02')).toEqual({ claude_code: expect.closeTo(3, 9) });
    const march = byPeriod.get('2026-03')!;
    expect(march.claude_code).toBeCloseTo(13, 9);
    expect(march.claude_cowork).toBeCloseTo(6, 9);
    expect(march.chatgpt).toBeCloseTo(5, 9);
    expect(march.codex).toBeCloseTo(4.5, 9);
    expect(march.claude).toBeUndefined();
    expect(byPeriod.get('2025-12')).toEqual({});
  });

  it('a closed month frozen before ChatGPT and Codex counts as Claude', async () => {
    const { buildSpendTrend } = await import('@/lib/finance/trend');
    // An old-style snapshot: per-person Code and Cowork, no OpenAI fields.
    await sql.run(`INSERT INTO chargeback_periods (period, status, closed_at, snapshot_json) VALUES ('2026-01', 'closed', ?, ?)`, [NOW, JSON.stringify({
      period: '2026-01', grandTotalUsd: 9, status: 'closed',
      costCentres: [{ name: 'Legal', code: null, totalUsd: 6, codeUsd: 4, coworkUsd: 2, users: [{ userId: 'u0', displayName: 'User 0', codeUsd: 4, coworkUsd: 2, totalUsd: 6 }] }],
      unallocated: { totalUsd: 3, users: [{ userId: 'x', displayName: 'x', codeUsd: 3, coworkUsd: 0, totalUsd: 3 }] },
    })]);
    // Older still: totals only, no per-product figures at all.
    await sql.run(`INSERT INTO chargeback_periods (period, status, closed_at, snapshot_json) VALUES ('2025-11', 'closed', ?, ?)`, [NOW, JSON.stringify({
      period: '2025-11', grandTotalUsd: 7, status: 'closed',
      costCentres: [{ name: 'Legal', totalUsd: 7, users: [{ userId: 'u0', displayName: 'User 0', totalUsd: 7 }] }],
      unallocated: { totalUsd: 0, users: [] },
    })]);
    try {
      const trend = await buildSpendTrend(NOW, 12);
      const byPeriod = new Map(trend.series.map(p => [p.period, p]));
      expect(byPeriod.get('2026-01')).toMatchObject({ usd: 9, parts: { claude_code: 7, claude_cowork: 2 } });
      expect(byPeriod.get('2025-11')).toMatchObject({ usd: 7, parts: { claude: 7 } });
    } finally {
      await sql.run(`DELETE FROM chargeback_periods`);
    }
  });

  it('with ChatGPT and Codex hidden, open months carry Claude parts only, still adding up to the headline', async () => {
    const { setConfigValue } = await import('@/lib/config');
    const { buildSpendTrend } = await import('@/lib/finance/trend');
    const { buildChargeback } = await import('@/lib/finance/chargeback');
    const { partsTotal } = await import('@/lib/finance/product-split');
    await setConfigValue('openaiShown', 'false');
    try {
      const trend = await buildSpendTrend(NOW, 12);
      const march = trend.series.find(p => p.period === '2026-03')!;
      expect(march.parts.chatgpt).toBeUndefined();
      expect(march.parts.codex).toBeUndefined();
      expect(partsTotal(march.parts)).toBeCloseTo((await buildChargeback('2026-03', NOW)).grandTotalUsd, 9);
      expect(partsTotal(march.parts)).toBeCloseTo(19, 9);
    } finally {
      await setConfigValue('openaiShown', 'true');
    }
  });

  it('the month-end projection splits into Claude and OpenAI, each from its own month-to-date spend', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
    try {
      const { GET } = await import('../app/api/finance/chargeback/route');
      const body = await (await GET(new NextRequest('http://localhost/api/finance/chargeback?period=2026-03'))).json();
      expect(body.monthToDate).toBe(true);
      expect(body.vendors.claudeUsd).toBeCloseTo(19, 9);
      expect(body.vendors.openaiUsd).toBeCloseTo(9.5, 9);
      // Day 20 of 31: each part at its own run rate, mtd / 20 x 31.
      expect(body.projectionByVendor.claudeUsd).toBeCloseTo(19 / 20 * 31, 6);
      expect(body.projectionByVendor.openaiUsd).toBeCloseTo(9.5 / 20 * 31, 6);
      expect(body.projectionByVendor.claudeUsd + body.projectionByVendor.openaiUsd).toBeCloseTo(body.projection.projected, 6);

      // A past month has no projection, so no split either.
      const feb = await (await GET(new NextRequest('http://localhost/api/finance/chargeback?period=2026-02'))).json();
      expect(feb.projection).toBeNull();
      expect(feb.projectionByVendor).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the concentration tiers split into each cost centre\'s products, adding up to the share', async () => {
    const { buildChargeback } = await import('@/lib/finance/chargeback');
    const { concentrationByProduct, partsTotal } = await import('@/lib/finance/product-split');
    const report = await buildChargeback('2026-03', NOW);
    const tiers = concentrationByProduct(report.costCentres)!;
    expect(tiers.length).toBeGreaterThan(0);
    for (const t of tiers) expect(partsTotal(t.parts)).toBeCloseTo(t.share, 9);
    // Top 1 is Legal (u0): $10 Claude Code and $4 ChatGPT of $28.50.
    expect(tiers[0].parts.claude_code).toBeCloseTo(10 / 28.5, 9);
    expect(tiers[0].parts.chatgpt).toBeCloseTo(4 / 28.5, 9);
  });
});
