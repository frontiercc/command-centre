// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// POST /api/pulse/briefing: everyone can generate their own Weekly Pulse;
// only admins and managers can generate anyone else's or the organisation
// briefings. Postgres; the session and the model call are mocked.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

const mockSession: { authenticated: boolean; role?: string; email?: string; userId?: string } = {
  authenticated: true, role: 'pulse', email: 'p1@example.com', userId: 'a1',
};

vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return { ...actual, getAdminSession: async () => mockSession };
});

const generated: string[] = [];
vi.mock('@/lib/pulse/briefings/weekly', async (orig) => {
  const actual = await orig<typeof import('@/lib/pulse/briefings/weekly')>();
  return { ...actual, generateUserWeeklyBriefing: async (userId: string) => { generated.push(userId); } };
});

let sql: TestSql;
let cleanup: () => Promise<void>;
const NOW = Math.floor(Date.now() / 1000);

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/pulse/briefing', {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
  });
}

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
  await sql.run(`INSERT INTO users (id, email, display_name, source, first_seen_at, last_seen_at) VALUES ('u1', 'p1@example.com', 'Person One', 'otel', ?, ?)`, [NOW, NOW]);
  await sql.run(`INSERT INTO users (id, email, display_name, source, first_seen_at, last_seen_at) VALUES ('u2', 'p2@example.com', 'Person Two', 'otel', ?, ?)`, [NOW, NOW]);
  await sql.run(`INSERT INTO admin_users (id, email, password_hash, role, linked_cowork_user_id) VALUES ('a1', 'p1@example.com', 'x', 'pulse', 'u1')`);
});
afterAll(async () => cleanup());
beforeEach(() => { generated.length = 0; mockSession.role = 'pulse'; });

describe('POST /api/pulse/briefing', () => {
  it('lets anyone generate their own Weekly Pulse', async () => {
    const { POST } = await import('../app/api/pulse/briefing/route');
    const res = await POST(post({ type: 'user', userId: 'u1' }));
    expect(res.status).toBe(200);
    expect(generated).toEqual(['u1']);
  });

  it("refuses someone else's Weekly Pulse and the organisation briefings to a non-admin", async () => {
    const { POST } = await import('../app/api/pulse/briefing/route');
    expect((await POST(post({ type: 'user', userId: 'u2' }))).status).toBe(403);
    expect((await POST(post({ type: 'cio' }))).status).toBe(403);
    expect((await POST(post({ type: 'all_users' }))).status).toBe(403);
    expect((await POST(post({ type: 'dept', dept: 'Sales' }))).status).toBe(403);
    expect(generated).toEqual([]);
  });

  it("lets a manager generate anyone's Weekly Pulse", async () => {
    mockSession.role = 'manager';
    const { POST } = await import('../app/api/pulse/briefing/route');
    expect((await POST(post({ type: 'user', userId: 'u2' }))).status).toBe(200);
    expect(generated).toEqual(['u2']);
  });
});
