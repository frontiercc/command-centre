// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';

let setConfigValue: typeof import('@/lib/config').setConfigValue;
let getConfigValue: typeof import('@/lib/config').getConfigValue;
let runCoworkSessionAggJob: typeof import('@/lib/pulse/cowork/session-aggregator').runCoworkSessionAggJob;
let cleanup: () => Promise<void>;
let sql: import('./helpers/sql').TestSql;

// The job and config helpers read the database, so give them a migrated test
// one rather than whatever default DB the process has.
beforeAll(async () => {
  const t = await createTestDatabase();
  cleanup = t.cleanup;
  sql = t.sql;
  ({ setConfigValue, getConfigValue } = await import('@/lib/config'));
  ({ runCoworkSessionAggJob } = await import('@/lib/pulse/cowork/session-aggregator'));
});

afterAll(async () => cleanup());

describe('cowork session-stats aggregation job gating', () => {
  it('runs and stamps last-run when no prior run is recorded', async () => {
    await setConfigValue('coworkSessionAggLastRun', '');
    await runCoworkSessionAggJob();
    expect(await getConfigValue('coworkSessionAggLastRun')).not.toBe('');
  });

  it('honours the hardcoded hourly cadence — skips a run inside the last hour', async () => {
    const stamp = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    await setConfigValue('coworkSessionAggLastRun', stamp);
    await runCoworkSessionAggJob();
    expect(await getConfigValue('coworkSessionAggLastRun')).toBe(stamp); // unchanged — skipped
  });

  it('runs again once the hourly cadence has elapsed', async () => {
    const stamp = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago > 1h interval
    await setConfigValue('coworkSessionAggLastRun', stamp);
    await runCoworkSessionAggJob();
    expect(await getConfigValue('coworkSessionAggLastRun')).not.toBe(stamp);
  });
});

// Hourly runs look only at sessions with a message received since the last
// complete run; a check of every session runs once a day. Checking every
// session every hour read the whole of cowork_messages.
describe('cowork session-stats aggregation job: new activity vs full check', () => {
  const NOW = Math.floor(Date.now() / 1000);
  let n = 0;

  async function addMessage(sessionId: string, at: number) {
    await sql.run(
      `INSERT INTO cowork_messages
         (id, session_id, user_id, message_type, surface, source, content_preview, occurred_at, ingested_at)
       VALUES (?, ?, 'wm-user', 'cowork_tool_metadata', 'cowork', 'otel', 'Read', ?, ?)`,
      [`wm-msg-${++n}`, sessionId, at, at],
    );
  }
  async function hasStats(sessionId: string) {
    return (await sql.get(`SELECT 1 AS x FROM cowork_session_stats WHERE session_id = ?`, [sessionId])) !== undefined;
  }
  async function due() {
    await setConfigValue('coworkSessionAggLastRun', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());
  }

  beforeAll(async () => {
    await sql.run(
      `INSERT INTO users (id, email, display_name) VALUES ('wm-user', 'wm-user@test.local', 'WM User') ON CONFLICT DO NOTHING`,
    );
  });

  it('first run checks every session and sets the watermark', async () => {
    await setConfigValue('coworkSessionAggWatermark', '');
    await setConfigValue('coworkSessionAggLastFullSweep', '');
    await addMessage('wm-old', NOW - 5 * 24 * 60 * 60);
    await due();
    await runCoworkSessionAggJob();

    expect(await hasStats('wm-old')).toBe(true);
    expect(Number(await getConfigValue('coworkSessionAggWatermark'))).toBeGreaterThan(NOW - 3600);
    expect(Number(await getConfigValue('coworkSessionAggLastFullSweep'))).toBeGreaterThanOrEqual(NOW);
  });

  it('an hourly run picks up a session with new messages and leaves older ones to the daily check', async () => {
    // Received long before the watermark and never rolled up: only a full check finds it.
    await addMessage('wm-missed', NOW - 3 * 24 * 60 * 60);
    await addMessage('wm-new', Math.floor(Date.now() / 1000));
    await due();
    await runCoworkSessionAggJob();

    expect(await hasStats('wm-new')).toBe(true);
    expect(await hasStats('wm-missed')).toBe(false);
  });

  it('a session already rolled up is recomputed when a new message arrives', async () => {
    const later = Math.floor(Date.now() / 1000) + 5;
    await addMessage('wm-new', later);
    await due();
    await runCoworkSessionAggJob();
    const row = (await sql.get(`SELECT last_event_at FROM cowork_session_stats WHERE session_id = 'wm-new'`)) as { last_event_at: number };
    expect(row.last_event_at).toBe(later);
  });

  it('the daily full check finds what the hourly runs skipped', async () => {
    await setConfigValue('coworkSessionAggLastFullSweep', String(NOW - 25 * 60 * 60));
    await due();
    await runCoworkSessionAggJob();
    expect(await hasStats('wm-missed')).toBe(true);
  });
});
