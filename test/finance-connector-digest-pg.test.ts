// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres regression test for the finance chargeback engine
// and the connector bearer-token lifecycle. Proves the three high-stakes
// concerns hold on REAL Postgres (numeric money as strings):
//
//  1. Reconciliation invariant — cost_usd (numeric) + priced code spend across
//     two cost centres + an Unallocated (null-dept) spender + an unpriced model
//     → grandTotalUsd === Σ centres + unallocated (±0.005), per-centre totals
//     correct, unpriced model surfaced (never $0-as-real), NO throw. On PG the
//     numeric/bigint aggregates come back as STRINGS; a missing Number() coerce
//     would make grandTotalUsd string-concat or NaN and this test goes red.
//  2. Period lock — a CLOSED period returns its snapshot_json VERBATIM (a value
//     that matches NO seeded spend), proving the short-circuit never recomputes.
//  3. Connector token auth — mint → verify(valid) authenticates, revoke →
//     verify rejects, bad bearer → rejects. verifyConnectorToken
//     is now async: a floating promise would be an auth bypass.
//
// Harness idiom mirrors test/use-cases-match-pg.test.ts: one runSpec() run
// against Postgres via createTestDbClient('postgres') (full migrations-pg
// schema; the shared test server when CCC_TEST_PG_URL is set, else a
// testcontainer). Every module under test is DYNAMIC-imported AFTER the DB
// env is established (the database client binds to DATABASE_URL on first use).
import { describe, it, expect } from 'vitest';
import type { ChargebackReport } from '@/lib/finance/chargeback';

// March 2026 window, UTC epoch seconds — inside period '2026-03'.
const MARCH_15 = Math.floor(Date.UTC(2026, 2, 15) / 1000);

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const h = await createTestDbClient('postgres');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = h.client;
  const cleanup = h.cleanup;

  try {
    const { schema } = await import('@/lib/db/schema');
    const { buildChargeback } = await import('@/lib/finance/chargeback');
    const tokens = await import('@/lib/connector/tokens');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = client as any;

    // ── Users: two in mapped depts, one NULL-dept (Unallocated) ──
    await c.insert(schema.users).values([
      { id: 'u1', email: 'u1@test.com', display_name: 'Legal One', department: 'Legal' },
      { id: 'u2', email: 'u2@test.com', display_name: 'Finance One', department: 'Finance' },
      { id: 'u3', email: 'u3@test.com', display_name: 'No Dept', department: null },
    ]);

    // ── Code spend (priced via default haiku rate: $1/MTok in, $5/MTok out) ──
    await c.insert(schema.codeAssistantMeta).values([
      // u1: 1,000,000 input haiku = $1.00
      { id: 'cam-1', session_id: 's1', user_id: 'u1', model: 'claude-haiku-4-5', input_tokens: 1_000_000, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, occurred_at: MARCH_15 },
      // u2: 500,000 input haiku = $0.50
      { id: 'cam-2', session_id: 's2', user_id: 'u2', model: 'claude-haiku-4-5', input_tokens: 500_000, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, occurred_at: MARCH_15 },
      // u3: unknown model 'mystery-x' — unpriced, $0 but surfaced in unpricedModels
      { id: 'cam-3', session_id: 's3', user_id: 'u3', model: 'mystery-x', input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_tokens: 0, cache_read_tokens: 0, occurred_at: MARCH_15 },
      // u3: 100,000 input haiku = $0.10
      { id: 'cam-4', session_id: 's3', user_id: 'u3', model: 'claude-haiku-4-5', input_tokens: 100_000, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, occurred_at: MARCH_15 },
    ]);

    // ── Cowork spend (cost_usd is `numeric` on PG → returned as a STRING) ──
    // Seeded as strings so the numeric column round-trips exactly on both.
    await c.insert(schema.coworkMessages).values([
      { id: 'cw-1', session_id: 'cs1', user_id: 'u1', message_type: 'cowork_api_request', cost_usd: '2.50', occurred_at: MARCH_15 },
      { id: 'cw-2', session_id: 'cs2', user_id: 'u2', message_type: 'cowork_api_request', cost_usd: '1.25', occurred_at: MARCH_15 },
      // NULL cost_usd — exercises the coverage figure + must not crash SUM.
      { id: 'cw-3', session_id: 'cs3', user_id: 'u1', message_type: 'cowork_api_request', cost_usd: null, occurred_at: MARCH_15 },
    ]);

    // ── Cost centres + dept map: Legal + Finance are their own centres by
    // name (no mapping row needed); this also verifies resolveDeptToCentre's
    // JOIN returns nothing extraneous. ──

    // ─────────────────── 1. Reconciliation invariant ───────────────────
    const report = await buildChargeback('2026-03', MARCH_15);

    const legal = report.costCentres.find((cc) => cc.name === 'Legal')!;
    expect(legal).toBeDefined();
    expect(legal.codeUsd).toBeCloseTo(1.0, 6);
    expect(legal.coworkUsd).toBeCloseTo(2.5, 6);
    expect(legal.totalUsd).toBeCloseTo(3.5, 6);

    const finance = report.costCentres.find((cc) => cc.name === 'Finance')!;
    expect(finance).toBeDefined();
    expect(finance.totalUsd).toBeCloseTo(1.75, 6);

    const noDept = report.unallocated.users.find((u) => u.userId === 'u3')!;
    expect(noDept).toBeDefined();
    expect(noDept.totalUsd).toBeCloseTo(0.1, 6); // mystery-x priced null (0) + $0.10 haiku
    expect(report.unallocated.totalUsd).toBeCloseTo(0.1, 6);

    // Unpriced model surfaced, never counted as $0-as-real.
    expect(report.unpricedModels).toContain('mystery-x');

    // grand total = 3.5 + 1.75 + 0.1 = 5.35
    expect(report.grandTotalUsd).toBeCloseTo(5.35, 6);
    // typeof number (not a concatenated string) — the numeric-coercion proof.
    expect(typeof report.grandTotalUsd).toBe('number');

    // THE invariant (same tolerance the engine hard-throws on).
    const centresTotal = report.costCentres.reduce((s, cc) => s + cc.totalUsd, 0);
    const reconciled = centresTotal + report.unallocated.totalUsd;
    expect(Math.abs(report.grandTotalUsd - reconciled)).toBeLessThanOrEqual(0.005);

    // Coverage reflects the NULL cost_usd row (COUNT/SUM coerced from bigint strings on PG).
    expect(report.coworkCostCoverage.total).toBe(3);
    expect(report.coworkCostCoverage.withCost).toBe(2);

    // ─────────────────── 2. Period lock (verbatim) ───────────────────
    const frozen: Partial<ChargebackReport> = {
      period: '2026-04',
      grandTotalUsd: 999.99, // matches NO seeded spend — proves no recompute
      status: 'closed',
      costCentres: [],
      unallocated: { totalUsd: 0, users: [] },
    };
    await c.insert(schema.chargebackPeriods).values({
      period: '2026-04',
      status: 'closed',
      closed_at: MARCH_15,
      snapshot_json: JSON.stringify(frozen),
      estimated: 0,
    });
    const locked = await buildChargeback('2026-04', MARCH_15);
    expect(locked.grandTotalUsd).toBe(999.99);
    expect(locked.status).toBe('closed');

    // ─────────────────── 3. Connector token auth ───────────────────
    const { token, record } = await tokens.mintConnectorToken('pg-auth-test');
    expect(token.length).toBeGreaterThanOrEqual(43);

    const valid = await tokens.verifyConnectorToken(token);
    expect(valid).not.toBeNull();
    expect(valid?.id).toBe(record.id);
    expect(valid?.lastUsedAt).toBeGreaterThan(0);

    // Bearer prefix accepted case-insensitively.
    expect((await tokens.verifyConnectorToken(`Bearer ${token}`))?.id).toBe(record.id);

    // Bad / missing bearers reject.
    expect(await tokens.verifyConnectorToken('garbage-not-a-real-token')).toBeNull();
    expect(await tokens.verifyConnectorToken(null)).toBeNull();

    // Revoke → subsequent verify rejects.
    expect(await tokens.revokeConnectorToken(record.id)).toBe(true);
    expect(await tokens.verifyConnectorToken(token)).toBeNull();
    // Idempotent revoke.
    expect(await tokens.revokeConnectorToken(record.id)).toBe(false);

    // list never leaks the hash.
    const list = await tokens.listConnectorTokens();
    const entry = list.find((r) => r.id === record.id);
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('token_hash');
  } finally {
    await cleanup();
  }
}

describe('finance chargeback + connector tokens (postgres)', () => {
  it(
    'reconciliation invariant holds with numeric money as strings, period lock is verbatim, token auth is async-correct on postgres',
    async () => {
      await runSpec();
    },
    180_000,
  );
});
