// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
// first_seen_at/last_seen_at for seeded users (bound as a parameter).
const SEED_NOW = Math.floor(Date.now() / 1000);

const cfg = { chargebackEnabled: true };
vi.mock('@/lib/config', () => ({
  getAllConfig: () => cfg,
  getConfigValue: () => undefined,
}));

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string };
vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return {
    ...actual,
    getAdminSession: () => sessionResult,
    // requireAdmin in the real module calls its own module-local getAdminSession
    // binding (not the mocked export), so it must be overridden directly here too.
    requireAdmin: () => (sessionResult.authenticated && sessionResult.role === 'admin' ? sessionResult : null),
  };
});

const logAccessMock = vi.fn();
vi.mock('@/lib/audit/log', () => ({
  logAccess: logAccessMock,
}));

function jsonRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json' },
  });
}

// April 2026 window, UTC epoch seconds.
const PERIOD = '2026-04';
const APRIL_15 = Math.floor(Date.UTC(2026, 3, 15) / 1000);

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  vi.resetModules();
  cfg.chargebackEnabled = true;
  logAccessMock.mockClear();
  await sql.exec('DELETE FROM chargeback_periods');
  await sql.exec('DELETE FROM code_assistant_meta');
  await sql.exec('DELETE FROM users');
  sessionResult = { authenticated: true, role: 'admin', userId: 'admin-1', email: 'admin@example.com' };

  await sql.run(
    `INSERT INTO users (id, email, display_name, source, department, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, 'otel', ?, ?, ?)`,
    ['u-eng-1', 'eng1@test.com', 'Eng One', 'Engineering', SEED_NOW, SEED_NOW]);

  // 1,000,000 input tokens of claude-haiku-4-5 ($1/MTok in) = $1.00
  await sql.run(
    `INSERT INTO code_assistant_meta (id, session_id, user_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['cam-close-1', 'sess-close-1', 'u-eng-1', 'claude-haiku-4-5', 1_000_000, 0, 0, 0, APRIL_15]);
});

describe('POST /api/finance/chargeback/close', () => {
  it('returns 404 when the feature flag is off', async () => {
    cfg.chargebackEnabled = false;
    const { POST } = await import('../app/api/finance/chargeback/close/route');
    const res = await POST(jsonRequest('/api/finance/chargeback/close', 'POST', { period: PERIOD }));
    expect(res.status).toBe(404);
  });

  it('returns 403 for a manager (non-admin) role', async () => {
    sessionResult = { authenticated: true, role: 'manager', userId: 'm1', email: 'm@x.test' };
    const { POST } = await import('../app/api/finance/chargeback/close/route');
    const res = await POST(jsonRequest('/api/finance/chargeback/close', 'POST', { period: PERIOD }));
    expect(res.status).toBe(403);
  });

  it('returns 400 for a malformed period', async () => {
    const { POST } = await import('../app/api/finance/chargeback/close/route');
    const res = await POST(jsonRequest('/api/finance/chargeback/close', 'POST', { period: '2026-4' }));
    expect(res.status).toBe(400);
  });

  it('admin closes a period: writes a chargeback_periods row with status=closed and a snapshot', async () => {
    const { POST } = await import('../app/api/finance/chargeback/close/route');
    const res = await POST(jsonRequest('/api/finance/chargeback/close', 'POST', { period: PERIOD }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(expect.objectContaining({ ok: true, period: PERIOD, status: 'closed' }));

    const row = await sql.get(`SELECT status, snapshot_json AS "snapshotJson" FROM chargeback_periods WHERE period = ?`, [PERIOD]) as
      { status: string; snapshotJson: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe('closed');
    expect(row!.snapshotJson).toBeTruthy();

    const snapshot = JSON.parse(row!.snapshotJson!);
    expect(snapshot.grandTotalUsd).toBeCloseTo(1.0, 6);

    expect(logAccessMock).toHaveBeenCalledWith(
      expect.objectContaining({ resource: 'finance/chargeback', action: 'WRITE', outcome: 'success' })
    );
  });

  it('immutability proof: buildChargeback returns the frozen snapshot verbatim even after new spend lands in the same period', async () => {
    const { POST } = await import('../app/api/finance/chargeback/close/route');
    const closeRes = await POST(jsonRequest('/api/finance/chargeback/close', 'POST', { period: PERIOD }));
    expect(closeRes.status).toBe(200);

    const row = await sql.get(`SELECT snapshot_json AS "snapshotJson" FROM chargeback_periods WHERE period = ?`, [PERIOD]) as
      { snapshotJson: string };
    const preMutationTotal = JSON.parse(row.snapshotJson).grandTotalUsd;
    expect(preMutationTotal).toBeCloseTo(1.0, 6);

    // Insert ANOTHER priced code row for the same month — would double the live number
    // if buildChargeback recomputed instead of reading the frozen snapshot.
    await sql.run(
      `INSERT INTO code_assistant_meta (id, session_id, user_id, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['cam-close-2', 'sess-close-2', 'u-eng-1', 'claude-haiku-4-5', 1_000_000, 0, 0, 0, APRIL_15]);

    const { buildChargeback } = await import('@/lib/finance/chargeback');
    const report = await buildChargeback(PERIOD);
    expect(report.status).toBe('closed');
    expect(report.grandTotalUsd).toBeCloseTo(preMutationTotal, 6);
    expect(report.grandTotalUsd).toBeCloseTo(1.0, 6); // NOT 2.0
  });

  it('returns 409 when re-closing an already-closed period', async () => {
    const { POST } = await import('../app/api/finance/chargeback/close/route');
    const first = await POST(jsonRequest('/api/finance/chargeback/close', 'POST', { period: PERIOD }));
    expect(first.status).toBe(200);
    const second = await POST(jsonRequest('/api/finance/chargeback/close', 'POST', { period: PERIOD }));
    expect(second.status).toBe(409);
  });
});
