// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';
import { seedUserSql } from './helpers/seed';

const notifyAlertSlackMock = vi.fn();
vi.mock('@/lib/alerts/notify-slack', () => ({ notifyAlertSlack: notifyAlertSlackMock }));

let sql: TestSql;
let cleanup: () => Promise<void>;
let runAlertSlackSweepJob: typeof import('@/lib/alerts/slack-sweep').runAlertSlackSweepJob;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  await seedUserSql(sql, 'user-1');
  const mod = await import('@/lib/alerts/slack-sweep');
  runAlertSlackSweepJob = mod.runAlertSlackSweepJob;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`DELETE FROM alerts; DELETE FROM config WHERE key LIKE 'alerts_slack_sweep_%';`);
  notifyAlertSlackMock.mockReset();
  notifyAlertSlackMock.mockResolvedValue(undefined);
});

async function seedAlert(
  id: string,
  severity: string,
  generatedAt: number,
  userId: string | null = 'user-1',
  rawEvidence: string | null = null,
) {
  await sql.run(
    `INSERT INTO alerts (id, user_id, alert_type, severity, title, explanation, raw_evidence, status, generated_at)
     VALUES (?, ?, 'anomaly', ?, ?, 'explanation', ?, 'open', ?)`,
    [id, userId, severity, `title-${id}`, rawEvidence, generatedAt],
  );
}

async function readConfigValue(key: string): Promise<string | undefined> {
  const row = await sql.get<{ value: string }>('SELECT value FROM config WHERE key = ?', [key]);
  return row?.value;
}

const NOW = 2_000_000;

describe('runAlertSlackSweepJob', () => {
  it('bootstraps the cursor to now on first run without notifying or backfilling', async () => {
    await seedAlert('old-critical', 'critical', NOW - 1000);
    const result = await runAlertSlackSweepJob(NOW);
    expect(result.swept).toBe(0);
    expect(notifyAlertSlackMock).not.toHaveBeenCalled();
  });

  it('notifies for high/critical alerts generated after the cursor', async () => {
    await runAlertSlackSweepJob(NOW); // bootstrap
    await seedAlert('new-high', 'high', NOW + 10);
    await seedAlert('new-critical', 'critical', NOW + 20);
    await seedAlert('new-medium', 'medium', NOW + 15);

    const result = await runAlertSlackSweepJob(NOW + 3601); // past the 1h cadence gate
    expect(result.swept).toBe(2);
    expect(notifyAlertSlackMock).toHaveBeenCalledTimes(2);
    const notifiedIds = notifyAlertSlackMock.mock.calls.map(c => c[0].id);
    expect(notifiedIds.sort()).toEqual(['new-critical', 'new-high']);
  });

  it('does not re-notify the same alert on a second sweep', async () => {
    await runAlertSlackSweepJob(NOW);
    await seedAlert('once-only', 'high', NOW + 10);
    await runAlertSlackSweepJob(NOW + 3601);
    notifyAlertSlackMock.mockClear();

    const result = await runAlertSlackSweepJob(NOW + 7202);
    expect(result.swept).toBe(0);
    expect(notifyAlertSlackMock).not.toHaveBeenCalled();
  });

  it('respects the one-hour cadence gate — a second call within the hour is a no-op', async () => {
    await runAlertSlackSweepJob(NOW);
    await seedAlert('too-soon', 'critical', NOW + 10);

    const result = await runAlertSlackSweepJob(NOW + 60); // only 1 minute later
    expect(result.swept).toBe(0);
    expect(notifyAlertSlackMock).not.toHaveBeenCalled();
  });

  it('caps a single sweep at 50 rows and drains the remainder on a later sweep', async () => {
    await runAlertSlackSweepJob(NOW); // bootstrap
    const total = 55;
    for (let i = 0; i < total; i++) {
      await seedAlert(`batch-${i}`, 'high', NOW + 10 + i);
    }

    const result = await runAlertSlackSweepJob(NOW + 3601); // past the 1h cadence gate
    expect(result.swept).toBe(50);
    expect(notifyAlertSlackMock).toHaveBeenCalledTimes(50);

    // Cursor advances to the 50th examined row's generated_at + 1 (ordered
    // ascending, so that's batch-49), not the last qualifying alert overall
    // (batch-54) — the remainder resumes correctly on a later sweep.
    const fiftiethGeneratedAt = NOW + 10 + 49;
    expect(await readConfigValue('alerts_slack_sweep_cursor')).toBe(String(fiftiethGeneratedAt + 1));

    notifyAlertSlackMock.mockClear();
    const result2 = await runAlertSlackSweepJob(NOW + 7202); // another hour later
    expect(result2.swept).toBe(5);
    expect(notifyAlertSlackMock).toHaveBeenCalledTimes(5);
    const notifiedIds = notifyAlertSlackMock.mock.calls.map(c => c[0].id).sort();
    expect(notifiedIds).toEqual(['batch-50', 'batch-51', 'batch-52', 'batch-53', 'batch-54']);
  });

  it('never forwards raw_evidence to notifyAlertSlack, even when the DB row has real evidence data', async () => {
    await runAlertSlackSweepJob(NOW); // bootstrap
    await seedAlert('with-evidence', 'critical', NOW + 10, 'user-1', JSON.stringify({ pii_type: 'ssn', snippet: 'sensitive' }));

    await runAlertSlackSweepJob(NOW + 3601);
    expect(notifyAlertSlackMock).toHaveBeenCalledTimes(1);
    expect(notifyAlertSlackMock.mock.calls[0][0].raw_evidence).toBeNull();
  });

  it('advances the cursor past a qualifying alert even while alertsSlackEnabled is unset/false', async () => {
    await runAlertSlackSweepJob(NOW); // bootstrap
    await seedAlert('flag-off', 'high', NOW + 10);

    // alertsSlackEnabled is left unset in config — notifyAlertSlack is fully
    // mocked here, so this proves the cursor movement independent of the
    // flag directly from the config table, not merely that the (always
    // permissive) mock was invoked.
    await runAlertSlackSweepJob(NOW + 3601);

    const cursor = await readConfigValue('alerts_slack_sweep_cursor');
    expect(cursor).toBeDefined();
    expect(Number(cursor)).toBeGreaterThan(NOW + 10);
  });
});
