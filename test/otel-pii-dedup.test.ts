// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { detectPiiWithMatches } from '@/lib/pii/detect';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

const emailMatch = (text: string) => detectPiiWithMatches(text).filter((m) => m.type === 'email');


describe('createPiiAlertsWithDedup', () => {
  let sql: TestSql;
  let cleanup: () => Promise<void>;
  let createPiiAlertsWithDedup: typeof import('@/lib/alerts/pii-alerts').createPiiAlertsWithDedup;

  beforeAll(async () => {
    const t = await createTestDatabase();
    sql = t.sql;
    cleanup = t.cleanup;
    // Dynamic import AFTER createTestDatabase resets the module cache.
    ({ createPiiAlertsWithDedup } = await import('@/lib/alerts/pii-alerts'));
  });
  afterAll(async () => cleanup());

  beforeEach(async () => {
    const now = Math.floor(Date.now() / 1000);
    await sql.run("DELETE FROM alerts WHERE user_id = 'dedup_test_user'");
    await sql.run("DELETE FROM users WHERE id = 'dedup_test_user'");
    // Create test user to satisfy foreign key constraint
    await sql.run(`
      INSERT INTO users (id, email, display_name, first_seen_at, last_seen_at)
      VALUES ('dedup_test_user', 'test@example.com', 'Test User', ?, ?)
    `, [now, now]);
  });

  it('creates alert on first delivery', async () => {
    await createPiiAlertsWithDedup('dedup_test_user', emailMatch('test@example.com'), 'test@example.com', 'msg-1', 'cowork');
    const count = (await sql.get<{ c: number }>(
      "SELECT COUNT(*) as c FROM alerts WHERE user_id = 'dedup_test_user'"
    ))!.c;
    expect(count).toBe(1);
  });

  it('skips duplicate within 24h', async () => {
    await createPiiAlertsWithDedup('dedup_test_user', emailMatch('test@example.com'), 'test@example.com', 'msg-1', 'cowork');
    await createPiiAlertsWithDedup('dedup_test_user', emailMatch('test@example.com'), 'test@example.com', 'msg-2', 'cowork');
    const count = (await sql.get<{ c: number }>(
      "SELECT COUNT(*) as c FROM alerts WHERE user_id = 'dedup_test_user'"
    ))!.c;
    expect(count).toBe(1);
  });

  it('creates new alert after 24h window expires', async () => {
    await sql.run(`
      INSERT INTO alerts (id, user_id, alert_type, raw_evidence, generated_at, severity, title, explanation)
      VALUES ('stale_01', 'dedup_test_user', 'policy', '{"pii_type":"email"}', ?, 'medium', 'Test', 'Test')
    `, [Math.floor(Date.now() / 1000) - 90000]);
    await createPiiAlertsWithDedup('dedup_test_user', emailMatch('new@example.com'), 'new@example.com', 'msg-3', 'cowork');
    const count = (await sql.get<{ c: number }>(
      "SELECT COUNT(*) as c FROM alerts WHERE user_id = 'dedup_test_user'"
    ))!.c;
    expect(count).toBe(2);
  });
});
