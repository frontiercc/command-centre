// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Work Pulse keeps its figures in memory (lib/kept-figures.ts). The figures a viewer's
// role changes must never be served from another viewer's load: an admin loads a page first, then
// a contributor and a viewer load the same page and get their own answer, not the admin's.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';

type Who = { authenticated: true; role: string; userId: string; email: string; department: string | null };
let who: Who;

vi.mock('@/lib/auth/admin-auth', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/auth/admin-auth')>();
  return { ...mod, getAdminSession: vi.fn(async () => who) };
});

const ADMIN: Who = { authenticated: true, role: 'admin', userId: 'admin-1', email: 'admin@test.local', department: null };
const VIEWER: Who = { authenticated: true, role: 'viewer', userId: 'viewer-1', email: 'viewer@test.local', department: null };
const FINANCE_CONTRIBUTOR: Who = { authenticated: true, role: 'pulse', userId: 'pulse-1', email: 'pulse@test.local', department: 'Finance' };
const SALES_CONTRIBUTOR: Who = { authenticated: true, role: 'pulse', userId: 'pulse-2', email: 'sales@test.local', department: 'Sales' };

let cleanup: () => Promise<void>;

beforeAll(async () => {
  const { createTestDbClient } = await import('./helpers/db');
  const made = await createTestDbClient('postgres');
  cleanup = made.cleanup;
  const { schema } = await import('@/lib/db/schema');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (made.client as any).insert(schema.users).values([
    { id: 'u-anna', email: 'anna@test.local', display_name: 'Anna', department: 'Finance' },
  ]);
  const { clearKeptFigures } = await import('@/lib/kept-figures');
  clearKeptFigures();
});

afterAll(async () => cleanup());

async function deptAs(viewer: Who) {
  who = viewer;
  const { GET } = await import('@/app/api/pulse/dept/[dept]/route');
  return GET(new NextRequest('http://x/api/pulse/dept/Finance?weeks=13&vendor=all&period=quarter'), { params: Promise.resolve({ dept: 'Finance' }) });
}

describe('Work Pulse Departments, kept in memory, answers each viewer for their role', () => {
  it('an admin, a contributor and a viewer loading the same team each get their own answer', async () => {
    const admin = await (await deptAs(ADMIN)).json();
    expect(admin.frontierAccess).toEqual({ canReview: true, canOpenUseCases: true });

    // The admin's figures are now kept. A contributor in the same team must not get them.
    const contributor = await (await deptAs(FINANCE_CONTRIBUTOR)).json();
    expect(contributor.frontierAccess).toEqual({ canReview: false, canOpenUseCases: false });

    const viewer = await (await deptAs(VIEWER)).json();
    expect(viewer.frontierAccess).toEqual({ canReview: false, canOpenUseCases: false });

    // And the admin still gets the admin's answer afterwards.
    expect((await (await deptAs(ADMIN)).json()).frontierAccess.canReview).toBe(true);
  });

  it("a contributor from another team is refused even once the team's figures are kept", async () => {
    await deptAs(ADMIN);
    const res = await deptAs(SALES_CONTRIBUTOR);
    expect(res.status).toBe(403);
  });
});
