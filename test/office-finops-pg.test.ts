// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Claude in Office and the money pages, on Postgres.
// Office sends tokens but no cost. Its spend is an estimate (lib/finance/office-spend.ts)
// shown on its own line; it must never reach Cowork's FinOps tile (tokens or the
// "no cost" coverage warning), the chargeback total, or Spend Review's Cowork review.
// Office rows come from the masked real capture, moved into the current month.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const NANO = BigInt(1_000_000_000);

function captureAt(startS: number) {
  const lines = fs.readFileSync(path.join(__dirname, 'fixtures', 'office-agent-capture.jsonl'), 'utf8')
    .split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
  let first: bigint | null = null;
  for (const l of lines) for (const rs of l.resourceSpans) for (const ss of rs.scopeSpans) for (const sp of ss.spans) {
    const s = BigInt(sp.startTimeUnixNano);
    if (first === null || s < first) first = s;
  }
  const base = BigInt(startS) * NANO;
  for (const l of lines) for (const rs of l.resourceSpans) for (const ss of rs.scopeSpans) for (const sp of ss.spans) {
    sp.startTimeUnixNano = String(BigInt(sp.startTimeUnixNano) - first! + base);
    sp.endTimeUnixNano = String(BigInt(sp.endTimeUnixNano) - first! + base);
  }
  return lines;
}

async function runSpec(): Promise<void> {
  const { createTestDatabase } = await import('./helpers/db');
  const { sql, cleanup } = await createTestDatabase();
  try {
    const { processOfficeSpans } = await import('@/lib/otel/office-receiver');
    const { buildChargeback } = await import('@/lib/finance/chargeback');
    const { buildSpendReview } = await import('@/lib/finance/spend-review');
    const { officeSpendByUser, summariseOfficeSpend } = await import('@/lib/finance/office-spend');
    const { buildByProduct } = await import('@/lib/pulse/cowork/by-product');
    const { currentPeriod, monthBounds } = await import('@/lib/finance/period');

    const nowS = Math.floor(Date.now() / 1000);
    const period = currentPeriod(nowS);
    const { start, end } = monthBounds(period);
    const t = Math.max(start + 3600, nowS - 3600);

    // One Cowork model call with a reported cost and tokens.
    await sql.run(`INSERT INTO users (id, email, display_name, first_seen_at, last_seen_at) VALUES ('cw-user', 'cowork.person@example.com', 'Cowork Person', ?, ?)`, [t, t]);
    await sql.run(`INSERT INTO cowork_sessions (id, conversation_id, user_id, source, started_at) VALUES ('cw-s1', 'cw-s1', 'cw-user', 'otel', ?)`, [t]);
    await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, model, cost_usd, token_usage, occurred_at) VALUES ('cw-a1', 'cw-s1', 'cw-user', 'cowork_api_request', 'cowork', 'otel', 'claude-sonnet-5', '2.5', ?, ?)`,
      [JSON.stringify({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0 }), t]);

    const before = await buildChargeback(period, nowS);

    // Before any Office activity, FinOps still lists every app, at zero.
    const none = summariseOfficeSpend(await officeSpendByUser(start, end), { allApps: true })!;
    expect(none.hasOffice).toBe(false);
    expect(none.byProduct.map(p => p.product)).toEqual(['excel', 'word', 'powerpoint', 'outlook', 'sheets', 'docs', 'slides']);
    expect(none.seen).toEqual({ office: false, google: false });
    for (const p of none.byProduct) expect(p).toMatchObject({ calls: 0, usd: null, people: 0 });
    expect(summariseOfficeSpend(await officeSpendByUser(start, end))).toBeNull();

    for (const line of captureAt(t - 600)) expect((await processOfficeSpans(line)).errors).toEqual([]);
    const officeUser = (await sql.get<{ user_id: string }>(`SELECT user_id FROM cowork_messages WHERE product IS NOT NULL LIMIT 1`))!.user_id;

    // 1. FinOps: Office changes nothing in the Cowork tile, the totals or the coverage warning.
    const after = await buildChargeback(period, nowS);
    expect(after.surfaces.cowork).toEqual(before.surfaces.cowork);
    expect(after.surfaces.total).toEqual(before.surfaces.total);
    expect(after.coworkCostCoverage).toEqual({ withCost: 1, total: 1 });
    expect(after.grandTotalUsd).toBe(before.grandTotalUsd);

    // 2. The Office estimate: tokens counted and priced at the built-in Opus 5.5 rate.
    let office = summariseOfficeSpend(await officeSpendByUser(start, end))!;
    expect(office.byProduct.map(p => p.product)).toEqual(['excel', 'word', 'powerpoint']);
    expect(office.total.calls).toBe(14);
    expect(office.total.tokens.inputTokens).toBeGreaterThan(0);
    expect(office.total.unpricedModels).toEqual([]);
    const atDefault = office.total.usd!;
    expect(atDefault).toBeGreaterThan(0);

    // A rate saved on Admin → Developer Pulse wins (here, double every price), and
    // Work Pulse shows the very same figure.
    await sql.run(`INSERT INTO config (key, value) VALUES ('code_model_rates', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [JSON.stringify({ 'claude-opus-5-5': { in: 8, out: 40, cacheWrite: 10, cacheRead: 0.4 } })]);
    office = summariseOfficeSpend(await officeSpendByUser(start, end))!;
    expect(office.total.usd).toBeCloseTo(atDefault * 2, 6);
    const panel = (await buildByProduct(nowS))!;
    const pulseWord = panel.rows.find(r => r.product === 'word')!.spendUsd!;
    const finopsWord = office.byProduct.find(p => p.product === 'word')!.usd!;
    expect(pulseWord).toBeCloseTo(finopsWord, 6);

    // 3. Spend Review: the Office person has no Cowork review; their Office estimate is separate.
    const review = await buildSpendReview(officeUser, period, nowS);
    expect(review.totals.sessions).toBe(0);
    expect(review.totals.coworkUsd).toBe(0);
    expect(review.work).toEqual([]);
    const mine = summariseOfficeSpend(await officeSpendByUser(start, end, officeUser))!;
    expect(mine.total.usd).toBeCloseTo(office.total.usd!, 6);

    // The Cowork person's review is unchanged by Office activity.
    const cw = await buildSpendReview('cw-user', period, nowS);
    expect(cw.totals.coworkUsd).toBe(2.5);
    expect(cw.totals.sessions).toBe(1);
  } finally {
    await cleanup();
  }
}

describe('Claude in Office on FinOps and Spend Review (postgres)', () => {
  it('keeps the Office estimate on its own line, out of every Cowork figure', async () => {
    await runSpec();
  }, 180_000);
});
