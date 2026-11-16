// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// My Pulse "Sessions with a by-hand estimate" on Postgres: the same sessions as the panel's totals
// (lib/pulse/my-period.ts), so Claude Cowork's session stats and ChatGPT's conversation time,
// following the All / Claude / ChatGPT switch.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import type { TestSql } from './helpers/sql';
import { createTestDatabase } from './helpers/db';

vi.mock('@/lib/auth/admin-auth', () => ({
  getAdminSession: vi.fn(() => ({ authenticated: true, role: 'admin', userId: 'admin-1', email: 'me@example.com' })),
  isDeptScoped: vi.fn(() => false),
  canAccessCoworkPulse: vi.fn(() => true),
}));
vi.mock('@/lib/auth/content-access', () => ({
  promptTextVisibleFor: vi.fn(async () => new Set<string>()),
  logPromptRead: vi.fn(async () => {}),
}));

let sql: TestSql;
let cleanup: () => Promise<void>;
let route: typeof import('../app/api/pulse/me/tasks/route');
const NOW = Math.floor(Date.now() / 1000);

beforeAll(async () => {
  ({ sql, cleanup } = await createTestDatabase());
  route = await import('../app/api/pulse/me/tasks/route');
  const t = NOW - 2 * 86400;
  await sql.run(`INSERT INTO users (id, email, display_name, first_seen_at, last_seen_at) VALUES ('me', 'me@example.com', 'Me', ?, ?)`, [t, t]);
  // Claude Cowork: one session with an estimate.
  await sql.run(`INSERT INTO cowork_sessions (id, conversation_id, user_id, source, started_at) VALUES ('cw-1', 'cw-1', 'me', 'otel', ?)`, [t]);
  await sql.run(`INSERT INTO cowork_session_stats (session_id, user_id, computed_at, first_event_at, last_event_at, active_secs, human_minutes_likely)
                 VALUES ('cw-1', 'me', ?, ?, ?, 600, 45)`, [NOW, t, t]);
  // ChatGPT: one conversation with an estimate, and one without (not listed).
  await sql.run(`INSERT INTO chatgpt_session_time (session_id, user_id, source, first_at, last_at, active_secs, human_minutes_likely, computed_at)
                 VALUES ('chatgpt:a', 'me', 'chatgpt_work', ?, ?, 300, 90, ?)`, [t, t, NOW]);
  await sql.run(`INSERT INTO chatgpt_session_time (session_id, user_id, source, first_at, last_at, active_secs, computed_at)
                 VALUES ('chatgpt:b', 'me', 'chatgpt_chat', ?, ?, 300, ?)`, [t, t, NOW]);
  // Departments: two people in Legal with a judged task each, and one in Sales.
  for (const [id, name, dept] of [['l1', 'Lena', 'Legal'], ['l2', 'Luc', 'Legal'], ['s1', 'Sam', 'Sales']]) {
    await sql.run(`INSERT INTO users (id, email, display_name, department, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`, [id, `${id}@example.com`, name, dept, t, t]);
    await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, content_full, occurred_at)
                   VALUES (?, ?, ?, 'cowork_user_message', 'cowork', 'otel', 'Draft the clause', ?)`, [`m-${id}`, `s-${id}`, id, t]);
    await sql.run(`INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at)
                   VALUES (?, ?, 2, 'analysis', 0.9, 'm', ?)`, [`m-${id}`, id, t]);
  }
});
afterAll(async () => cleanup());

async function list(vendor: string) {
  const res = await route.GET(new NextRequest(`http://localhost/api/pulse/me/tasks?kind=humantime&period=month&vendor=${vendor}`));
  return ((await res.json()).items as Array<{ sessionId: string; humanMinutes: number; claudeMinutes: number }>);
}

describe('GET /api/pulse/me/tasks?kind=humantime', () => {
  it('lists Claude Cowork and ChatGPT sessions with an estimate, biggest first, and follows the switch', async () => {
    expect((await list('all')).map(r => r.sessionId)).toEqual(['chatgpt:a', 'cw-1']);
    expect((await list('all'))[0]).toMatchObject({ humanMinutes: 90, claudeMinutes: 5 });
    expect((await list('claude')).map(r => r.sessionId)).toEqual(['cw-1']);
    expect((await list('openai')).map(r => r.sessionId)).toEqual(['chatgpt:a']);
  });
});

describe('GET /api/pulse/me/tasks?dept=', () => {
  it("lists the department's tasks, every member's, each naming whose, and never the caller's own", async () => {
    const res = await route.GET(new NextRequest('http://localhost/api/pulse/me/tasks?kind=tasks&period=month&vendor=all&dept=Legal'));
    const items = (await res.json()).items as Array<{ name: string; taskType: string; text: string | null }>;
    expect(items.map(i => i.name).sort()).toEqual(['Lena', 'Luc']);
    // Prompt text follows the content rule: nobody here may read it (mocked), so none is sent.
    expect(items.every(i => i.text === null)).toBe(true);
  });

  it('refuses a department-scoped role another department', async () => {
    const auth = await import('@/lib/auth/admin-auth');
    vi.mocked(auth.getAdminSession).mockResolvedValueOnce({ authenticated: true, role: 'pulse', userId: 'p', email: 'p@example.com', department: 'Sales' } as never);
    vi.mocked(auth.isDeptScoped).mockReturnValueOnce(true);
    const res = await route.GET(new NextRequest('http://localhost/api/pulse/me/tasks?kind=tasks&period=month&dept=Legal'));
    expect(res.status).toBe(403);
  });
});
