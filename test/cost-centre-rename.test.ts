// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// renameCentre (app/api/finance/cost-centres/route.ts)
// OVERWRITES `code` from the request body — omitting it silently nulls the
// GL code. This locks the full-body round-trip contract the new admin UI
// relies on: create with a code, rename while round-tripping that same code,
// and confirm (via a follow-up GET, since renameCentre's own response is a
// bare `{ ok: true }`) that the code survived.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string } | null =
  { authenticated: true, role: 'admin', userId: 'u1', email: 'admin@example.com' };
vi.mock('@/lib/auth/admin-auth', () => ({
  requireAdmin: vi.fn(() => (sessionResult?.authenticated && sessionResult.role === 'admin' ? sessionResult : null)),
}));
vi.mock('@/lib/audit/log', () => ({ logAccess: vi.fn() }));

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/finance/cost-centres', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function get(): NextRequest {
  return new NextRequest('http://localhost/api/finance/cost-centres', { method: 'GET' });
}

describe('cost centre rename preserves GL code when round-tripped', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const t = await createTestDatabase();
    cleanup = t.cleanup;
    const { setConfigValue } = await import('@/lib/config');
    await setConfigValue('chargebackEnabled', 'true');
  });

  afterAll(async () => cleanup());

  it('rename with round-tripped code keeps the GL code', async () => {
    const { POST, GET } = await import('../app/api/finance/cost-centres/route');

    // createCentre -> 201 { id, name, code } (read from the route)
    const createRes = await POST(post({ action: 'createCentre', name: 'Enginering', code: 'GL-100' }));
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    const id = created.id;
    expect(created.code).toBe('GL-100');

    // renameCentre -> 200 { ok: true } — no centre payload, so the GOTCHA
    // (omitting `code` nulls it) must be verified via a follow-up GET.
    const renameRes = await POST(post({ action: 'renameCentre', id, name: 'Engineering', code: 'GL-100' }));
    expect(renameRes.status).toBe(200);
    expect((await renameRes.json()).ok).toBe(true);

    const listRes = await GET(get());
    expect(listRes.status).toBe(200);
    const { centres } = await listRes.json();
    const centre = centres.find((c: { id: number }) => c.id === id);
    expect(centre).toBeDefined();
    expect(centre.name).toBe('Engineering');
    expect(centre.code).toBe('GL-100'); // the trap this task exists to prevent
  });

  it('renaming WITHOUT round-tripping code nulls it (documents the gotcha the UI must avoid)', async () => {
    const { POST, GET } = await import('../app/api/finance/cost-centres/route');

    const createRes = await POST(post({ action: 'createCentre', name: 'Marketing', code: 'GL-200' }));
    const { id } = await createRes.json();

    // Deliberately omit `code` — this is the trap: renameCentre overwrites it to null.
    const renameRes = await POST(post({ action: 'renameCentre', id, name: 'Marketing Team' }));
    expect(renameRes.status).toBe(200);

    const listRes = await GET(get());
    const { centres } = await listRes.json();
    const centre = centres.find((c: { id: number }) => c.id === id);
    expect(centre.name).toBe('Marketing Team');
    expect(centre.code).toBeNull();
  });
});
