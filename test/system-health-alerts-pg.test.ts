// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// System-health alerts raised from job_runs, once per failure (switch on) and the
// hourly cadence — POSTGRES ONLY.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let cleanup: () => Promise<void>;
let sqlTag: typeof import('drizzle-orm').sql;
let mod: typeof import('@/lib/alerts/system-health-alerts');

async function run(text: string): Promise<Array<Record<string, unknown>>> {
  const r = await db.execute(sqlTag.raw(text));
  return (r.rows ?? r) as Array<Record<string, unknown>>;
}

const NOW = Math.floor(Date.now() / 1000);
const alerts = () => run(`SELECT title, severity, user_id, raw_evidence->>'rule' AS rule, raw_evidence->>'subject' AS subject FROM alerts WHERE alert_type = 'system_health' ORDER BY title`);

describe('runSystemHealthAlerts (postgres)', () => {
  beforeAll(async () => {
    const { createTestDbClient } = await import('./helpers/db');
    const c = await createTestDbClient('postgres');
    db = c.client; cleanup = c.cleanup;
    sqlTag = (await import('drizzle-orm')).sql;
    mod = await import('@/lib/alerts/system-health-alerts');
  }, 180_000);
  afterAll(async () => { if (cleanup) await cleanup(); });
  beforeEach(async () => {
    await run(`DELETE FROM job_runs`);
    await run(`DELETE FROM alerts WHERE alert_type = 'system_health'`);
    await run(`DELETE FROM cowork_messages`);
    await run(`DELETE FROM code_otel_metrics`);
    await run(`DELETE FROM config WHERE key LIKE 'telemetry_silence_%'`);
    await run(`INSERT INTO config (key, value) VALUES ('system_health_alerts_enabled', 'true') ON CONFLICT (key) DO UPDATE SET value = 'true'`);
  });

  it('raises high alerts with no user, and does not repeat them within 24 hours', async () => {
    await run(`INSERT INTO job_runs (job_name, last_failed_at, last_error, consecutive_failures) VALUES
               ('github_sync', ${NOW - 60}, 'GitHub API errors: acme/api commits: HTTP 401', 1),
               ('use_case_tracker', ${NOW - 60}, 'boom', 3)`);
    await run(`INSERT INTO job_runs (job_name, last_succeeded_at, consecutive_failures) VALUES ('retention_cleanup', ${NOW - 30 * 3600}, 0)`);
    expect(await mod.runSystemHealthAlerts(NOW)).toBe(3);
    const a = await alerts();
    expect(a).toEqual([
      { title: 'GitHub key rejected', severity: 'high', user_id: null, rule: 'key_rejected', subject: 'github_sync' },
      { title: 'Retention has not run in over a day', severity: 'high', user_id: null, rule: 'retention_stale', subject: 'retention_cleanup' },
      { title: 'Scheduled job failing: Use case tracker', severity: 'high', user_id: null, rule: 'job_failing', subject: 'use_case_tracker' },
    ]);
    expect(await mod.runSystemHealthAlerts(NOW + 3600)).toBe(0);
    // Once per failure: still failing two days later is the same problem.
    expect(await mod.runSystemHealthAlerts(NOW + 2 * 86400)).toBe(0);
    expect(await alerts()).toHaveLength(3);
  });

  it('raises again only after the job has succeeded and then failed again', async () => {
    await run(`INSERT INTO job_runs (job_name, last_failed_at, last_error, consecutive_failures) VALUES ('use_case_tracker', ${NOW - 60}, 'boom', 2)`);
    expect(await mod.runSystemHealthAlerts(NOW)).toBe(1);
    await run(`UPDATE job_runs SET last_succeeded_at = ${NOW + 100}, consecutive_failures = 0 WHERE job_name = 'use_case_tracker'`);
    expect(await mod.runSystemHealthAlerts(NOW + 200)).toBe(0);
    await run(`UPDATE job_runs SET last_failed_at = ${NOW + 300}, consecutive_failures = 2 WHERE job_name = 'use_case_tracker'`);
    expect(await mod.runSystemHealthAlerts(NOW + 400)).toBe(1);
    expect(await alerts()).toHaveLength(2);
  });

  it('raises nothing when the switch is off (the default); System health still shows it', async () => {
    await run(`UPDATE config SET value = 'false' WHERE key = 'system_health_alerts_enabled'`);
    await run(`INSERT INTO job_runs (job_name, last_failed_at, last_error, consecutive_failures) VALUES ('use_case_tracker', ${NOW - 60}, 'boom', 3)`);
    expect(await mod.runSystemHealthAlerts(NOW)).toBe(0);
    expect(await alerts()).toHaveLength(0);
  });

  it('the scheduler entry point runs at most hourly, using its own job_runs row', async () => {
    await run(`INSERT INTO job_runs (job_name, last_failed_at, last_error, consecutive_failures) VALUES ('use_case_tracker', ${NOW}, 'boom', 2)`);
    await run(`INSERT INTO job_runs (job_name, last_succeeded_at, consecutive_failures) VALUES ('system_health_alerts', ${NOW - 600}, 0)`);
    expect(await mod.runSystemHealthAlertsJob(NOW)).toBe(false);
    expect(await alerts()).toHaveLength(0);
    expect(await mod.runSystemHealthAlertsJob(NOW + 3600)).toBe(true);
    expect(await alerts()).toHaveLength(1);
  });

  describe('telemetry silence', () => {
    // Wed 30 Sep 2026 15:00 BST: a working-day afternoon.
    const WED = Math.floor(Date.parse('2026-09-30T14:00:00Z') / 1000);
    // An alert's generated_at is the database clock; dedup compares it with the
    // silence's start, so stamp each run's alerts with the simulated time.
    const runAt = async (t: number) => {
      const n = await mod.runSystemHealthAlerts(t);
      await run(`UPDATE alerts SET generated_at = ${t} WHERE alert_type = 'system_health' AND generated_at > ${NOW - 3600}`);
      return n;
    };
    const msg = (id: string, surface: string, ingestedAt: number, occurredAt = ingestedAt) =>
      run(`INSERT INTO cowork_messages (id, session_id, message_type, surface, occurred_at, ingested_at)
           VALUES ('${id}', 's-${id}', 'cowork_user_message', '${surface}', ${occurredAt}, ${ingestedAt})`);
    const silence = async () => (await alerts()).filter(a => a.rule === 'telemetry_silence');

    it('raises one alert per quiet surface, from when the hub last RECEIVED it, once per silence', async () => {
      await msg('c1', 'cowork', WED - 4 * 3600);   // Cowork quiet 4 working hours
      await msg('k1', 'code', WED - 600);          // Code fine
      // A late batch: received 10 min ago, stamped by the client a day ago, so Code metrics is fine too.
      await run(`INSERT INTO code_otel_metrics (id, metric_name, occurred_at, ingested_at) VALUES ('m1', 'claude_code.lines_of_code.count', ${WED - 86400}, ${WED - 600})`);
      expect(await runAt(WED)).toBe(1);
      expect(await silence()).toEqual([{ title: 'No Cowork telemetry for 4 working hours', severity: 'high', user_id: null, rule: 'telemetry_silence', subject: 'cowork' }]);
      // Still quiet an hour later: the same silence, not raised again.
      expect(await runAt(WED + 3600)).toBe(0);
      // Cowork comes back, then goes quiet again: a new silence.
      await msg('c2', 'cowork', WED + 7200);
      expect(await runAt(WED + 7300)).toBe(0);
      await msg('k2', 'code', WED + 86000);
      await run(`INSERT INTO code_otel_metrics (id, metric_name, occurred_at, ingested_at) VALUES ('m2', 'claude_code.lines_of_code.count', ${WED + 86000}, ${WED + 86000})`);
      expect(await runAt(WED + 86400)).toBe(1);
      expect(await silence()).toHaveLength(2);
    });

    it('follows the hub settings: 0 hours is off, and the time zone moves the working day', async () => {
      await msg('c1', 'cowork', WED - 4 * 3600);
      await run(`INSERT INTO config (key, value) VALUES ('telemetry_silence_hours', '0')`);
      expect(await mod.runSystemHealthAlerts(WED)).toBe(0);
      await run(`UPDATE config SET value = '3' WHERE key = 'telemetry_silence_hours'`);
      // 10:00–14:00 UTC is 07:00–11:00 in São Paulo: with a 09-18 day that is 2 working hours.
      await run(`INSERT INTO config (key, value) VALUES ('telemetry_silence_timezone', 'America/Sao_Paulo'), ('telemetry_silence_work_hours', '09-18')`);
      expect(await mod.runSystemHealthAlerts(WED)).toBe(0);
      expect(await mod.runSystemHealthAlerts(WED + 3600)).toBe(1);
    });

    it('raises nothing when the system health switch is off', async () => {
      await run(`UPDATE config SET value = 'false' WHERE key = 'system_health_alerts_enabled'`);
      await msg('c1', 'cowork', WED - 6 * 3600);
      expect(await mod.runSystemHealthAlerts(WED)).toBe(0);
    });
  });
});
