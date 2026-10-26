// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';
import { seedUserSql } from './helpers/seed';

let sql: TestSql;
let cleanup: () => Promise<void>;

// Dynamically imported query functions (bound to test DB)
let getLatestAlertTimestamp: () => Promise<number>;
let hasRecentAlertForUserAndType: (userId: string | null, alertType: string) => Promise<boolean>;
let insertAlert: (alert: {
  id: string; user_id: string | null; alert_type: string;
  severity: string; title: string; explanation: string; raw_evidence: string;
}) => Promise<void>;
let updateAlertStatus: (id: string, status: string, resolvedBy?: string) => Promise<void>;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const queries = await import('@/lib/db/queries');
  getLatestAlertTimestamp = queries.getLatestAlertTimestamp;
  hasRecentAlertForUserAndType = queries.hasRecentAlertForUserAndType;
  insertAlert = queries.insertAlert;
  updateAlertStatus = queries.updateAlertStatus;

  // Seed a user for FK constraints
  await seedUserSql(sql, 'user-1');
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec('DELETE FROM alerts');
});

// ─── Helpers ──────────────────────────────────────────────────────────────

async function insertTestAlert(id: string, opts: {
  userId?: string | null; alertType?: string; severity?: string;
} = {}) {
  await insertAlert({
    id,
    user_id: 'userId' in opts ? opts.userId! : 'user-1',
    alert_type: opts.alertType ?? 'anomaly',
    severity: opts.severity ?? 'medium',
    title: 'Test alert',
    explanation: 'Test explanation',
    raw_evidence: '{}',
  });
}

async function setAlertTimestamp(id: string, ts: number) {
  await sql.run('UPDATE alerts SET generated_at = ? WHERE id = ?', [ts, id]);
}

// ─── getLatestAlertTimestamp ──────────────────────────────────────────────

describe('getLatestAlertTimestamp', () => {
  it('returns 0 on empty DB', async () => {
    expect(await getLatestAlertTimestamp()).toBe(0);
  });

  it('returns the highest generated_at after inserts', async () => {
    await insertTestAlert('alert-1');
    await insertTestAlert('alert-2');

    await setAlertTimestamp('alert-1', 1000);
    await setAlertTimestamp('alert-2', 2000);

    expect(await getLatestAlertTimestamp()).toBe(2000);
  });
});

// ─── hasRecentAlertForUserAndType ────────────────────────────────────────

describe('hasRecentAlertForUserAndType', () => {
  it('returns false when no alerts exist', async () => {
    expect(await hasRecentAlertForUserAndType('user-1', 'anomaly')).toBe(false);
  });

  it('returns true when open alert matches user_id + alert_type', async () => {
    await insertTestAlert('alert-1', { userId: 'user-1', alertType: 'anomaly' });

    expect(await hasRecentAlertForUserAndType('user-1', 'anomaly')).toBe(true);
  });

  it('returns true when alert is resolved (within 7 days)', async () => {
    await insertTestAlert('alert-1', { userId: 'user-1', alertType: 'anomaly' });
    await updateAlertStatus('alert-1', 'resolved', 'admin');

    expect(await hasRecentAlertForUserAndType('user-1', 'anomaly')).toBe(true);
  });

  it('returns true when alert is dismissed (within 7 days)', async () => {
    await insertTestAlert('alert-1', { userId: 'user-1', alertType: 'anomaly' });
    await updateAlertStatus('alert-1', 'dismissed', 'admin');

    expect(await hasRecentAlertForUserAndType('user-1', 'anomaly')).toBe(true);
  });

  it('returns false for alert older than 7 days', async () => {
    await insertTestAlert('alert-1', { userId: 'user-1', alertType: 'anomaly' });
    // Backdate the alert to 8 days ago
    const eightDaysAgo = Math.floor(Date.now() / 1000) - 8 * 86400;
    await setAlertTimestamp('alert-1', eightDaysAgo);

    expect(await hasRecentAlertForUserAndType('user-1', 'anomaly')).toBe(false);
  });

  it('returns false for different alert_type', async () => {
    await insertTestAlert('alert-1', { userId: 'user-1', alertType: 'anomaly' });

    expect(await hasRecentAlertForUserAndType('user-1', 'policy')).toBe(false);
  });

  it('returns false for different user_id', async () => {
    await seedUserSql(sql, 'user-2');
    await insertTestAlert('alert-1', { userId: 'user-1', alertType: 'anomaly' });

    expect(await hasRecentAlertForUserAndType('user-2', 'anomaly')).toBe(false);
  });

  it('handles null user_id correctly', async () => {
    await insertTestAlert('alert-1', { userId: null, alertType: 'risk' });

    expect(await hasRecentAlertForUserAndType(null, 'risk')).toBe(true);
    expect(await hasRecentAlertForUserAndType('user-1', 'risk')).toBe(false);
  });
});
