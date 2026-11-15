// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The register shows a use case's lifecycle beside its sessions. The two must
// never contradict: a use case shown as Piloting or Adopted has sessions the
// row shows. Two ways they used to disagree:
//  - an archived use case keeps the stage it had when archived (the tracker
//    stops refreshing it), while the session judge drops its matches, so it
//    read "Piloting" beside 0 sessions;
//  - Piloting counts this week's sessions, the register's count is the last
//    13 completed weeks, so a use case seen only this week read "Piloting"
//    beside 0.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import { seedUserSql } from './helpers/seed';
import type { TestSql } from './helpers/sql';
import { weekStart } from '@/lib/pulse/period';

vi.mock('@/lib/auth/admin-auth', () => ({
  getAdminSession: vi.fn(() => ({ authenticated: true, role: 'admin', userId: 'admin-1', email: 'admin@example.com' })),
  canAccessPulseAdmin: (role?: string) => role === 'admin' || role === 'manager',
}));

let sql: TestSql;
let cleanup: () => Promise<void>;
const NOW = Math.floor(Date.now() / 1000);

async function useCase(id: string, status: string, lifecycle: string) {
  await sql.run(`INSERT INTO use_cases (id, title, description, status, lifecycle, origin, created_at, updated_at)
    VALUES (?, ?, 'Work', ?, ?, 'planned', ?, ?)`, [id, id, status, lifecycle, NOW, NOW]);
}

beforeAll(async () => {
  ({ sql, cleanup } = await createTestDatabase());
  await seedUserSql(sql, 'u1');
  const { saveConfig } = await import('@/lib/config');
  await saveConfig({ useCasesEnabled: 'true' });

  // Archived while piloting; its matches have since gone.
  await useCase('uc-archived', 'archived', 'piloting');

  // Piloting on a session this week only.
  await useCase('uc-this-week', 'confirmed', 'piloting');
  const wk = weekStart(NOW);
  await sql.run(`INSERT INTO cowork_sessions (id, conversation_id, user_id) VALUES ('s-now', 's-now', 'u1')`);
  await sql.run(`INSERT INTO cowork_session_stats (session_id, user_id, first_event_at, last_event_at, computed_at, active_secs)
    VALUES ('s-now', 'u1', ?, ?, ?, 600)`, [wk + 60, wk + 660, wk + 660]);
  await sql.run(`INSERT INTO use_case_activation_weeks (use_case_id, week_start, distinct_users, session_count, matched_messages, updated_at)
    VALUES ('uc-this-week', ?, 1, 1, 2, ?)`, [wk, NOW]);
  await sql.run(`INSERT INTO use_case_week_matches (use_case_id, week_start, user_id, session_id) VALUES ('uc-this-week', ?, 'u1', 's-now')`, [wk]);
}, 120_000);

afterAll(async () => cleanup?.());

interface Row {
  id: string;
  lifecycle: string | null;
  productSessions: { cowork: number; code: number; chatgpt: number | null; codex: number | null };
  sessionsThisWeek: number;
}

async function list(): Promise<Row[]> {
  const { GET } = await import('../app/api/use-cases/route');
  const res = await GET(new NextRequest('http://localhost/api/use-cases'));
  expect(res.status).toBe(200);
  return res.json();
}

const shown = (r: Row) => r.productSessions.cowork + r.productSessions.code
  + (r.productSessions.chatgpt ?? 0) + (r.productSessions.codex ?? 0) + (r.sessionsThisWeek ?? 0);

describe('GET /api/use-cases: lifecycle and sessions agree', () => {
  it('never shows Piloting or Adopted beside no sessions', async () => {
    for (const r of await list()) {
      if (r.lifecycle === 'piloting' || r.lifecycle === 'adopted') expect(shown(r), r.id).toBeGreaterThan(0);
    }
  });

  it('an archived use case is not tracked, so it has no stage', async () => {
    const r = (await list()).find(x => x.id === 'uc-archived')!;
    expect(r.lifecycle).toBeNull();
  });

  it("a use case seen only this week carries this week's sessions beside its 13-week count", async () => {
    const r = (await list()).find(x => x.id === 'uc-this-week')!;
    expect(r.lifecycle).toBe('piloting');
    expect(r.productSessions.cowork).toBe(0);
    expect(r.sessionsThisWeek).toBe(1);
  });

  it('the detail route gives an archived use case no stage either', async () => {
    const { GET } = await import('../app/api/use-cases/[id]/route');
    const res = await GET(new NextRequest('http://localhost/api/use-cases/uc-archived'), { params: Promise.resolve({ id: 'uc-archived' }) });
    expect(res.status).toBe(200);
    expect((await res.json()).lifecycle).toBeNull();
  });
});
