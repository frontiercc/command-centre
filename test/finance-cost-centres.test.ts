// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
// first_seen_at/last_seen_at for seeded users (bound parameters).
const SEED_NOW = Math.floor(Date.now() / 1000);
let resolveDeptToCentre: typeof import('@/lib/finance/cost-centres').resolveDeptToCentre;
let buildChargeback: typeof import('@/lib/finance/chargeback').buildChargeback;

// March 2026 window, UTC epoch seconds.
const MARCH_15 = Math.floor(Date.UTC(2026, 2, 15) / 1000);

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
  resolveDeptToCentre = (await import('@/lib/finance/cost-centres')).resolveDeptToCentre;
  buildChargeback = (await import('@/lib/finance/chargeback')).buildChargeback;

  // --- Cost centres ---
  // RETURNING id gives each new centre's id.
  const rd = await sql.get<{ id: number }>(`INSERT INTO chargeback_cost_centres (name, code) VALUES (?, ?) RETURNING id`, ['R&D', '4100']);
  const ops = await sql.get<{ id: number }>(`INSERT INTO chargeback_cost_centres (name, code) VALUES (?, ?) RETURNING id`, ['Ops', '5200']);
  const rdId = rd!.id;
  const opsId = ops!.id;

  // --- Dept map: Engineering -> R&D, Data -> R&D, Support -> Ops. Legal left unmapped. ---
  await sql.run(`INSERT INTO chargeback_dept_map (department, cost_centre_id) VALUES (?, ?)`, ['Engineering', rdId]);
  await sql.run(`INSERT INTO chargeback_dept_map (department, cost_centre_id) VALUES (?, ?)`, ['Data', rdId]);
  await sql.run(`INSERT INTO chargeback_dept_map (department, cost_centre_id) VALUES (?, ?)`, ['Support', opsId]);

  // --- Users ---
  await sql.run(
    `INSERT INTO users (id, email, display_name, source, department, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, 'otel', ?, ?, ?)`,
    ['u-eng-1', 'eng1@test.com', 'Eng One', 'Engineering', SEED_NOW, SEED_NOW]);
  await sql.run(
    `INSERT INTO users (id, email, display_name, source, department, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, 'otel', ?, ?, ?)`,
    ['u-data-1', 'data1@test.com', 'Data One', 'Data', SEED_NOW, SEED_NOW]);
  await sql.run(
    `INSERT INTO users (id, email, display_name, source, department, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, 'otel', ?, ?, ?)`,
    ['u-legal-1', 'legal1@test.com', 'Legal One', 'Legal', SEED_NOW, SEED_NOW]);

  // --- code_assistant_meta: claude-haiku-4-5, 1e6 input tokens = $1.00 each ---
  await sql.run(
    `INSERT INTO code_assistant_meta (id, session_id, user_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['cam-eng-1', 'sess-eng-1', 'u-eng-1', 'claude-haiku-4-5', 1_000_000, 0, 0, 0, MARCH_15]);
  await sql.run(
    `INSERT INTO code_assistant_meta (id, session_id, user_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['cam-data-1', 'sess-data-1', 'u-data-1', 'claude-haiku-4-5', 1_000_000, 0, 0, 0, MARCH_15]);
  await sql.run(
    `INSERT INTO code_assistant_meta (id, session_id, user_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['cam-legal-1', 'sess-legal-1', 'u-legal-1', 'claude-haiku-4-5', 1_000_000, 0, 0, 0, MARCH_15]);
});

afterAll(async () => cleanup());

describe('resolveDeptToCentre', () => {
  it('maps several departments to one named cost centre with GL code', async () => {
    const map = await resolveDeptToCentre();
    expect(map.get('Engineering')).toEqual({ name: 'R&D', code: '4100' });
    expect(map.get('Data')).toEqual({ name: 'R&D', code: '4100' });
    expect(map.get('Support')).toEqual({ name: 'Ops', code: '5200' });
  });

  it('does not include unmapped departments', async () => {
    const map = await resolveDeptToCentre();
    expect(map.has('Legal')).toBe(false);
  });
});

describe('buildChargeback with cost-centre grouping', () => {
  it('merges Engineering + Data under one R&D centre and keeps Legal separate', async () => {
    const report = await buildChargeback('2026-03', MARCH_15);

    const rdCentres = report.costCentres.filter(c => c.name === 'R&D');
    expect(rdCentres).toHaveLength(1);
    const rd = rdCentres[0];
    expect(rd.code).toBe('4100');
    expect(rd.users).toHaveLength(2);
    const userIds = rd.users.map(u => u.userId).sort();
    expect(userIds).toEqual(['u-data-1', 'u-eng-1']);
    // $1.00 + $1.00 = $2.00
    expect(rd.totalUsd).toBeCloseTo(2.0, 6);
    expect(rd.codeUsd).toBeCloseTo(2.0, 6);

    const legal = report.costCentres.find(c => c.name === 'Legal')!;
    expect(legal).toBeDefined();
    expect(legal.code).toBeNull();
    expect(legal.users).toHaveLength(1);
    expect(legal.totalUsd).toBeCloseTo(1.0, 6);
  });

  it('reconciles grandTotalUsd against the sum of centres + unallocated', async () => {
    const report = await buildChargeback('2026-03', MARCH_15);
    const sumCentres = report.costCentres.reduce((s, c) => s + c.totalUsd, 0);
    const total = sumCentres + report.unallocated.totalUsd;
    expect(Math.abs(report.grandTotalUsd - total)).toBeLessThanOrEqual(0.005);
    // Hand-computed: 2.0 (R&D) + 1.0 (Legal) = 3.0
    expect(report.grandTotalUsd).toBeCloseTo(3.0, 6);
  });
});
