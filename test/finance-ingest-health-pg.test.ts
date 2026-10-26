// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres regression test for two of the converted
// route handlers' OWN inline queries (async Drizzle). Proves on REAL Postgres:
//   - finance/cost-centres POST: createCentre returns a real id via
//     .returning() (not .lastInsertRowid) and mapDept's
//     onConflictDoUpdate upsert round-trips correctly.
//   - health GET: the unauthenticated liveness probe keeps returning 200
//     with `{ status: 'ok' }` against a real Postgres connection, and the
//     signed-in response carries the db block.
//
// Harness mirrors test/library-routes-pg.test.ts: one runSpec() run against
// Postgres (the shared test server when CCC_TEST_PG_URL is set, else a
// testcontainer). Config/auth are mocked; everything else hits the REAL DB
// via a fresh dynamic import (the database client binds to DATABASE_URL on first use, so
// every module under test is imported AFTER the DB env is established).
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

const cfg = { chargebackEnabled: true };
vi.mock('@/lib/config', () => ({
  getAllConfig: () => cfg,
  getConfigValue: () => undefined,
}));

const mockSession = { authenticated: true, role: 'admin', email: 'admin@test.com', userId: 'admin-1' };
vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return {
    ...actual,
    getAdminSession: async () => mockSession,
    // requireAdmin in the real module calls its own module-local
    // getAdminSession binding (not the mocked export), so it must be
    // overridden directly here too (same idiom as finance-cost-centres-route.test.ts).
    requireAdmin: async () => (mockSession.authenticated && mockSession.role === 'admin' ? mockSession : null),
  };
});

const logAccessMock = vi.fn();
vi.mock('@/lib/audit/log', () => ({
  logAccess: logAccessMock,
}));

function makeRequest(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}
function jsonRequest(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const h = await createTestDbClient('postgres');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = h.client;
  const cleanup = h.cleanup;

  try {
    const { schema } = await import('@/lib/db/schema');
    const { eq } = await import('drizzle-orm');

    // ═══════════════════ finance/cost-centres POST (admin write) ═══════════════════
    cfg.chargebackEnabled = true;
    const { POST: costCentresPOST } = await import('../app/api/finance/cost-centres/route');

    const createRes = await costCentresPOST(jsonRequest('/api/finance/cost-centres', 'POST', {
      action: 'createCentre',
      name: 'R&D',
      code: '4100',
    }));
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    // .returning() must give back a real id (never .lastInsertRowid, which
    // does not exist on the pg driver).
    expect(typeof created.id).toBe('number');
    expect(created.name).toBe('R&D');
    expect(created.code).toBe('4100');

    const mapRes = await costCentresPOST(jsonRequest('/api/finance/cost-centres', 'POST', {
      action: 'mapDept',
      department: 'Engineering',
      costCentreId: created.id,
    }));
    expect(mapRes.status).toBe(200);

    // Round-trip via the typed client directly — proves the onConflictDoUpdate
    // upsert actually persisted, not just that the route returned 200.
    const mapRows = await client
      .select({ department: schema.chargebackDeptMap.department, costCentreId: schema.chargebackDeptMap.cost_centre_id })
      .from(schema.chargebackDeptMap)
      .where(eq(schema.chargebackDeptMap.department, 'Engineering'));
    expect(mapRows).toHaveLength(1);
    expect(mapRows[0].costCentreId).toBe(created.id);

    // Re-mapping the SAME department to a new centre exercises
    // onConflictDoUpdate's UPDATE branch (not a duplicate row).
    const secondCentreRes = await costCentresPOST(jsonRequest('/api/finance/cost-centres', 'POST', {
      action: 'createCentre',
      name: 'Ops',
    }));
    const secondCentre = await secondCentreRes.json();
    await costCentresPOST(jsonRequest('/api/finance/cost-centres', 'POST', {
      action: 'mapDept',
      department: 'Engineering',
      costCentreId: secondCentre.id,
    }));
    const remappedRows = await client
      .select({ costCentreId: schema.chargebackDeptMap.cost_centre_id })
      .from(schema.chargebackDeptMap)
      .where(eq(schema.chargebackDeptMap.department, 'Engineering'));
    expect(remappedRows).toHaveLength(1); // still one row, not two
    expect(remappedRows[0].costCentreId).toBe(secondCentre.id);

    expect(logAccessMock).toHaveBeenCalledWith(
      expect.objectContaining({ resource: 'finance/cost-centres', action: 'WRITE', outcome: 'success' })
    );

    // ═══════════════════ health GET (unauthenticated, must stay 200) ═══════════════════
    // Docker's healthcheck hits this route with NO session cookie — flip the
    // mocked session to unauthenticated for this one call to exercise that
    // literal branch (the route's `{ status }`-only shape), then restore it.
    mockSession.authenticated = false;
    const { GET: healthGET } = await import('../app/api/health/route');
    const healthRes = await healthGET(makeRequest('/api/health'));
    mockSession.authenticated = true;
    expect(healthRes.status).toBe(200);
    const healthBody = await healthRes.json();
    expect(healthBody.status).toBe('ok');
    expect(healthBody.db).toBeUndefined(); // unauthenticated shape omits db/version/uptime

    // Signed in: the db block reports the connection and nothing about agents.
    const authedRes = await healthGET(makeRequest('/api/health'));
    expect(authedRes.status).toBe(200);
    const authedBody = await authedRes.json();
    expect(authedBody.db).toEqual({ ok: true, migrations: 0 });
  } finally {
    await cleanup();
  }
}

describe('finance/health routes (postgres)', () => {
  it(
    'perform correct RETURNING writes, onConflictDoUpdate upserts and liveness checks on real postgres',
    async () => {
      await runSpec();
    },
    180_000,
  );
});
