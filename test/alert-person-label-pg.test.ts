// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Alert text must name the person, never carry a raw user id: the Slack sweep
// sends stored text as it is (e.g. a spend spike reached
// Slack as "<64-character id> spent $127.53…"). Covers the shared name lookup and
// the two alert writers not covered elsewhere (use case at risk, user export).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import { seedUserSql } from './helpers/seed';
import type { TestSql } from './helpers/sql';

vi.mock('@/lib/auth/admin-auth', () => ({ requireAdmin: vi.fn(async () => true) }));

const HASH = '3c9e1f0a7b2d4e6f8a1c3e5f7b9d2a4c6e8f0a1b3d5c7e9f1a2b4c6d8e0f1a3b';
const UUID = '5b1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';

let sql: TestSql;
let cleanup: () => Promise<void>;
let personLabel: typeof import('@/lib/alerts/person-label').personLabel;
let replaceUserIdsWithNames: typeof import('@/lib/alerts/person-label').replaceUserIdsWithNames;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  ({ personLabel, replaceUserIdsWithNames } = await import('@/lib/alerts/person-label'));
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec('DELETE FROM alerts; DELETE FROM use_cases; DELETE FROM admin_users; DELETE FROM users;');
  await seedUserSql(sql, HASH, 'jane.smith@test.local');
  await seedUserSql(sql, UUID, 'sam.jones@test.local');
});

async function linkAdmin(userId: string, email: string, name: string) {
  await sql.run(
    `INSERT INTO admin_users (id, email, password_hash, role, display_name, linked_cowork_user_id) VALUES (?, ?, 'x', 'pulse', ?, ?)`,
    [`adm-${userId.slice(0, 6)}`, email, name, userId],
  );
}

describe('personLabel', () => {
  it('prefers the linked admin display name, then the users name, then the email', async () => {
    expect(await personLabel(HASH)).toBe('jane.smith@test.local');
    await sql.run('UPDATE users SET display_name = ? WHERE id = ?', ['Auto Name', HASH]);
    expect(await personLabel(HASH)).toBe('Auto Name');
    await linkAdmin(HASH, 'jane.smith@test.local', 'Jane Smith');
    expect(await personLabel(HASH)).toBe('Jane Smith');
  });

  it('never returns the id for an unknown person', async () => {
    expect(await personLabel('no-such-user-id-at-all')).toBe('An unknown user');
  });
});

describe('replaceUserIdsWithNames', () => {
  beforeEach(async () => {
    await linkAdmin(HASH, 'jane.smith@test.local', 'Jane Smith');
    await sql.run('UPDATE users SET display_name = ? WHERE id = ?', ['Sam Jones', UUID]);
  });

  it('replaces full ids, shortened ids and uuids', async () => {
    const text = `User ${HASH} used 4x tokens; 3c9e1f0a... and 3c9e1f0a7b2d… did too, as did ${UUID}.`;
    const out = await replaceUserIdsWithNames(text, [HASH, UUID]);
    expect(out).toBe('User Jane Smith used 4x tokens; Jane Smith and Jane Smith did too, as did Sam Jones.');
  });

  it('leaves text with no known id unchanged, including hex that is not an id', async () => {
    const text = 'Commit deadbeefcafe0000 touched 3 files.';
    expect(await replaceUserIdsWithNames(text, [HASH, UUID])).toBe(text);
  });
});

describe('use case at risk', () => {
  it('names the owner, not the owner id', async () => {
    await linkAdmin(HASH, 'jane.smith@test.local', 'Jane Smith');
    const { createUseCase } = await import('@/lib/usecases/queries');
    const { runUseCaseAtRiskAlerts } = await import('@/lib/alerts/use-case-alerts');
    const uc = await createUseCase({ title: 'Contract triage', keywords: ['x'], status: 'confirmed', ownerUserId: HASH });
    await runUseCaseAtRiskAlerts(uc, 'adopted');
    const row = (await sql.get(`SELECT explanation FROM alerts WHERE alert_type = 'use_case_at_risk'`)) as { explanation: string };
    expect(row.explanation).toContain('Owner: Jane Smith.');
    expect(row.explanation).not.toContain(HASH);
  });
});

describe('user data export', () => {
  it('the audit alert names the person, not the id', async () => {
    await linkAdmin(HASH, 'jane.smith@test.local', 'Jane Smith');
    const { GET } = await import('../app/api/users/export/route');
    const res = await GET(new NextRequest(`http://localhost/api/users/export?id=${HASH}`));
    expect(res.status).toBe(200);
    const row = (await sql.get(`SELECT explanation FROM alerts WHERE title = 'User data exported'`)) as { explanation: string };
    expect(row.explanation).toMatch(/^Data for Jane Smith exported by admin on /);
    expect(row.explanation).not.toContain(HASH);
  });
});
