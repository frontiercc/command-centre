// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
let getCodeDeptMembers: (dept: string) => Promise<Array<{
  user_id: string; session_count: number; spend_usd: number | null; commit_count: number;
}>>;

const DEPT = 'AppliedAI';

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  getCodeDeptMembers = (await import('@/lib/pulse/code/dept')).getCodeDeptMembers;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`DELETE FROM code_metrics WHERE scope_id LIKE 'u%'`);
  await sql.exec(`DELETE FROM admin_users WHERE email LIKE '%@applied.test'`);
  await sql.exec(`DELETE FROM users WHERE email LIKE '%@applied.test'`);
});

const NOW = Math.floor(Date.now() / 1000);

async function addUser(id: string, dept: string | null) {
  await sql.run(`INSERT INTO users (id, email, display_name, source, department, first_seen_at, last_seen_at)
              VALUES (?, ?, ?, 'otel', ?, ?, ?)`, [id, `${id}@applied.test`, id.toUpperCase(), dept, NOW, NOW]);
}
async function addUserMetrics(id: string) {
  await sql.run(`INSERT INTO code_metrics (scope_type, scope_id, period_start, period_end, spend_usd, session_count, commit_count, computed_at)
              VALUES ('user', ?, 0, 0, 42.5, 7, 3, ?)`, [id, NOW]);
}

describe('getCodeDeptMembers — full roster (membership-first)', () => {
  it('returns ALL department members, including those with no Code activity', async () => {
    // 5-member department; only u1 has recent Code activity (a user-scope code_metrics row).
    await addUser('u1', DEPT); await addUserMetrics('u1');
    await addUser('u2', DEPT);
    await addUser('u3', DEPT);
    await addUser('u4', DEPT);
    // u5 belongs to the dept via admin_users (department NOT on the users row).
    await addUser('u5', null);
    await sql.run(`INSERT INTO admin_users (id, email, password_hash, display_name, role, department, linked_cowork_user_id)
                VALUES ('a5', 'u5@applied.test', 'x', 'U5', 'pulse', ?, 'u5')`, [DEPT]);

    const members = await getCodeDeptMembers(DEPT);
    expect(members).toHaveLength(5);
    // Active member carries its metrics; inactive members are present with zeroed counts.
    const u1 = members.find(m => m.user_id === 'u1')!;
    expect(u1.spend_usd).toBe(42.5);
    expect(u1.session_count).toBe(7);
    const u3 = members.find(m => m.user_id === 'u3')!;
    expect(u3.spend_usd).toBeNull();
    expect(u3.session_count).toBe(0);
    // The admin_users-only member is included.
    expect(members.some(m => m.user_id === 'u5')).toBe(true);
  });

  it('does not duplicate a member who is in both the users and admin_users paths', async () => {
    await addUser('u1', DEPT); await addUserMetrics('u1');
    await sql.run(`INSERT INTO admin_users (id, email, password_hash, display_name, role, department, linked_cowork_user_id)
                VALUES ('a1', 'u1@applied.test', 'x', 'U1', 'pulse', ?, 'u1')`, [DEPT]);
    const members = await getCodeDeptMembers(DEPT);
    expect(members.filter(m => m.user_id === 'u1')).toHaveLength(1);
  });

  it('matches the department string case-sensitively on Postgres (plain `=`, not LIKE)', async () => {
    await addUser('u1', DEPT);
    const differentCase = DEPT.toLowerCase();
    expect(differentCase).not.toBe(DEPT);

    const exactMatch = await getCodeDeptMembers(DEPT);
    expect(exactMatch.some(m => m.user_id === 'u1')).toBe(true);

    const wrongCase = await getCodeDeptMembers(differentCase);
    expect(wrongCase.some(m => m.user_id === 'u1')).toBe(false);
  });
});
