// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';
import { seedUserSql } from './helpers/seed';

let sql: TestSql;
let cleanup: () => Promise<void>;

let suggestBaselineProcessCount: typeof import('@/lib/pulse/metrics/psr').suggestBaselineProcessCount;
let suggestBaselineProcessCountForDept: typeof import('@/lib/pulse/metrics/psr').suggestBaselineProcessCountForDept;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 24 * 60 * 60;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const psrMod = await import('@/lib/pulse/metrics/psr');
  suggestBaselineProcessCount = psrMod.suggestBaselineProcessCount;
  suggestBaselineProcessCountForDept = psrMod.suggestBaselineProcessCountForDept;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`DELETE FROM pulse_classifications; DELETE FROM cowork_messages; DELETE FROM users; DELETE FROM admin_users;`);
});

/** Mirrors the OTel receivers' auto-created admin_users row (role='pulse', department mirrored, linked_cowork_user_id set). */
async function seedAdminUserForDept(adminId: string, coworkUserId: string, department: string) {
  await sql.run(
    `INSERT INTO admin_users (id, email, password_hash, role, department, linked_cowork_user_id)
     VALUES (?, ?, '__otel_pending__', 'pulse', ?, ?)`,
    [adminId, `${adminId}@test.com`, department, coworkUserId],
  );
}

let msgSeq = 0;

/** Seed a cowork_messages row + a classified pulse_classifications row at a given time/task_type. */
async function seedClassifiedTask(userId: string, taskType: string, occurredAt: number, status = 'classified') {
  const msgId = `msg-${++msgSeq}`;
  await sql.run(
    `INSERT INTO cowork_messages
       (id, session_id, user_id, message_type, role, content_preview, occurred_at, ingested_at)
     VALUES (?, 'sess-1', ?, 'cowork_user_message', 'user', 'do the thing', ?, ?)`,
    [msgId, userId, occurredAt, occurredAt],
  );

  await sql.run(
    `INSERT INTO pulse_classifications
       (cowork_message_id, user_id, tier, task_type, classifier_confidence,
        classifier_model, classifier_status, classified_at)
     VALUES (?, ?, 1, ?, 0.9, 'test-model', ?, ?)`,
    [msgId, userId, taskType, status, occurredAt],
  );
}

describe('suggestBaselineProcessCount', () => {
  it('counts distinct in-window task types for a team, ignoring out-of-window activity', async () => {
    await seedUserSql(sql, 'user-a1');
    await sql.run(`UPDATE users SET team_id = ? WHERE id = ?`, ['team-a', 'user-a1']);

    await seedClassifiedTask('user-a1', 'task_one', NOW - 1 * DAY);
    await seedClassifiedTask('user-a1', 'task_two', NOW - 2 * DAY);
    await seedClassifiedTask('user-a1', 'task_three', NOW - 3 * DAY);
    await seedClassifiedTask('user-a1', 'task_four', NOW - 4 * DAY);
    // Out-of-window (31 days ago) — must not count
    await seedClassifiedTask('user-a1', 'task_five', NOW - 31 * DAY);

    expect(await suggestBaselineProcessCount('team-a')).toBe(4);
  });

  it('returns 0 for a team with no activity', async () => {
    await seedUserSql(sql, 'user-b1');
    await sql.run(`UPDATE users SET team_id = ? WHERE id = ?`, ['team-b', 'user-b1']);

    expect(await suggestBaselineProcessCount('team-b')).toBe(0);
  });

  it('is org-wide (counts union across all users) when no teamId is given', async () => {
    await seedUserSql(sql, 'user-c1');
    await seedUserSql(sql, 'user-c2');
    await sql.run(`UPDATE users SET team_id = ? WHERE id = ?`, ['team-c1', 'user-c1']);
    await sql.run(`UPDATE users SET team_id = ? WHERE id = ?`, ['team-c2', 'user-c2']);

    await seedClassifiedTask('user-c1', 'task_alpha', NOW - 1 * DAY);
    await seedClassifiedTask('user-c2', 'task_beta', NOW - 1 * DAY);
    await seedClassifiedTask('user-c2', 'task_alpha', NOW - 2 * DAY); // duplicate type — distinct count still 2

    expect(await suggestBaselineProcessCount()).toBe(2);
  });

  it('excludes classifications with classifier_status != classified', async () => {
    await seedUserSql(sql, 'user-d1');
    await sql.run(`UPDATE users SET team_id = ? WHERE id = ?`, ['team-d', 'user-d1']);

    await seedClassifiedTask('user-d1', 'task_pending', NOW - 1 * DAY, 'pending');
    await seedClassifiedTask('user-d1', 'task_failed', NOW - 1 * DAY, 'failed');

    expect(await suggestBaselineProcessCount('team-d')).toBe(0);
  });
});

describe('suggestBaselineProcessCountForDept', () => {
  it('counts distinct in-window task types for a department, ignoring out-of-window activity', async () => {
    await seedUserSql(sql, 'user-e1');
    await seedAdminUserForDept('admin-e1', 'user-e1', 'Engineering');

    await seedClassifiedTask('user-e1', 'task_one', NOW - 1 * DAY);
    await seedClassifiedTask('user-e1', 'task_two', NOW - 2 * DAY);
    await seedClassifiedTask('user-e1', 'task_three', NOW - 31 * DAY); // out-of-window

    expect(await suggestBaselineProcessCountForDept('Engineering')).toBe(2);
  });

  it('returns 0 for a department with no activity', async () => {
    await seedUserSql(sql, 'user-f1');
    await seedAdminUserForDept('admin-f1', 'user-f1', 'Sales');

    expect(await suggestBaselineProcessCountForDept('Sales')).toBe(0);
  });

  it('only counts users linked to that department via admin_users, not other departments', async () => {
    await seedUserSql(sql, 'user-g1');
    await seedUserSql(sql, 'user-g2');
    await seedAdminUserForDept('admin-g1', 'user-g1', 'Engineering');
    await seedAdminUserForDept('admin-g2', 'user-g2', 'Sales');

    await seedClassifiedTask('user-g1', 'task_eng', NOW - 1 * DAY);
    await seedClassifiedTask('user-g2', 'task_sales', NOW - 1 * DAY);

    expect(await suggestBaselineProcessCountForDept('Engineering')).toBe(1);
    expect(await suggestBaselineProcessCountForDept('Sales')).toBe(1);
  });
});
