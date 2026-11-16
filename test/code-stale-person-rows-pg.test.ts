// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Each hourly run writes the organisation row first, then a row only for people
// with sessions in its window. Someone who stopped using a tool keeps a row from
// an older run, which the person-level readers (the people table, a department's
// members, a person's page) must not show as current: they have no activity in
// that view. POSTGRES ONLY.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import type { TestSql } from './helpers/sql';
import { createTestDatabase } from './helpers/db';

vi.mock('@/lib/auth/admin-auth', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/admin-auth')>();
  return { ...actual, getAdminSession: async () => ({ authenticated: true, role: 'admin', email: 'admin@example.org' }) };
});

let sql: TestSql;
let cleanup: () => Promise<void>;
const NOW = Math.floor(Date.now() / 1000);
const RUN = NOW - 600;         // the latest run
const OLD_RUN = RUN - 3600;    // the run before it

beforeAll(async () => {
  ({ sql, cleanup } = await createTestDatabase());
});
afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`DELETE FROM code_metrics; DELETE FROM code_metrics_vendor; DELETE FROM cowork_messages; DELETE FROM users;`);
  await sql.run(`INSERT INTO users (id, email, display_name, department, source, first_seen_at, last_seen_at) VALUES
    ('u-now', 'now@example.org', 'Now', 'Eng', 'otel', 1, ?),
    ('u-gone', 'gone@example.org', 'Gone', 'Eng', 'otel', 1, ?)`, [NOW, NOW]);
});

/** Rows in `table` (with `vendor` when it is code_metrics_vendor): two runs, u-gone only in the older. */
async function seedRuns(table: 'code_metrics' | 'code_metrics_vendor', vendor?: string) {
  const cols = vendor ? 'vendor, ' : '';
  const v = vendor ? [vendor] : [];
  const row = (scopeType: string, scopeId: string, computedAt: number, sessions: number) => sql.run(
    `INSERT INTO ${table} (${cols}scope_type, scope_id, granularity, period_start, period_end, session_count, spend_usd, computed_at)
     VALUES (${vendor ? '?, ' : ''}?, ?, 'rolling', ?, ?, ?, ?, ?)`,
    [...v, scopeType, scopeId, computedAt - 7 * 86400, computedAt, sessions, sessions * 2, computedAt]);
  await row('organisation', 'org', OLD_RUN, 5);
  await row('user', 'u-now', OLD_RUN + 1, 2);
  await row('user', 'u-gone', OLD_RUN + 2, 3);
  await row('organisation', 'org', RUN, 2);
  await row('user', 'u-now', RUN + 1, 2);
}

async function users(vendor: string) {
  const { GET } = await import('../app/api/pulse/code/users/route');
  const body = await (await GET(new NextRequest(`http://localhost/api/pulse/code/users?vendor=${vendor}`))).json();
  return (body.users as Array<{ user_id: string }>).map(u => u.user_id);
}

async function me(userId: string, vendor: string) {
  const { GET } = await import('../app/api/pulse/code/me/route');
  return (await GET(new NextRequest(`http://localhost/api/pulse/code/me?userId=${userId}&vendor=${vendor}`))).json();
}

describe('person-level rows from the latest run only', () => {
  it('on code_metrics (no Codex data)', async () => {
    await seedRuns('code_metrics');
    expect(await users('all')).toEqual(['u-now']);

    const { getCodeDeptMembers } = await import('@/lib/pulse/code/dept');
    const members = await getCodeDeptMembers('Eng');
    const gone = members.find(m => m.user_id === 'u-gone')!;
    expect(gone.session_count).toBe(0);
    expect(gone.spend_usd).toBeNull();
    expect(members.find(m => m.user_id === 'u-now')!.session_count).toBe(2);

    expect((await me('u-gone', 'all')).metrics).toBeNull();
    expect((await me('u-now', 'all')).metrics.session_count).toBe(2);
  }, 60_000);

  it('on code_metrics_vendor, per view', async () => {
    await sql.run(`INSERT INTO cowork_messages (id, user_id, session_id, message_type, surface, source, occurred_at, ingested_at)
      VALUES ('cx-1', NULL, 'codex:s', 'code_user_message', 'code', 'codex', ?, ?)`, [NOW, NOW]);
    await seedRuns('code_metrics_vendor', 'claude');
    // In the Codex view u-gone is still current: only the Claude view is stale for them.
    await sql.run(`INSERT INTO code_metrics_vendor (vendor, scope_type, scope_id, granularity, period_start, period_end, session_count, computed_at)
      VALUES ('openai', 'organisation', 'org', 'rolling', ?, ?, 1, ?), ('openai', 'user', 'u-gone', 'rolling', ?, ?, 1, ?)`,
      [RUN - 7 * 86400, RUN, RUN + 5, RUN - 7 * 86400, RUN, RUN + 6]);

    expect(await users('claude')).toEqual(['u-now']);
    expect(await users('openai')).toEqual(['u-gone']);

    const { getCodeDeptMembers } = await import('@/lib/pulse/code/dept');
    const { pickCodeMetricsSource } = await import('@/lib/pulse/code/vendor-view');
    const members = await getCodeDeptMembers('Eng', await pickCodeMetricsSource('claude', true));
    expect(members.find(m => m.user_id === 'u-gone')!.session_count).toBe(0);

    expect((await me('u-gone', 'claude')).metrics).toBeNull();
    expect((await me('u-gone', 'openai')).metrics.session_count).toBe(1);
    expect((await me('u-now', 'claude')).metrics.session_count).toBe(2);
  }, 60_000);
});
