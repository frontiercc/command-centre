// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
let buildDigest: typeof import('@/lib/digest/build').buildDigest;
let weekStart: typeof import('@/lib/pulse/period').weekStart;
let setConfigValue: typeof import('@/lib/config').setConfigValue;
let createUseCase: typeof import('@/lib/usecases/queries').createUseCase;
let updateUseCase: typeof import('@/lib/usecases/queries').updateUseCase;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
const WEEK = 7 * DAY;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const build = await import('@/lib/digest/build');
  buildDigest = build.buildDigest;

  const period = await import('@/lib/pulse/period');
  weekStart = period.weekStart;

  const config = await import('@/lib/config');
  setConfigValue = config.setConfigValue;

  const queries = await import('@/lib/usecases/queries');
  createUseCase = queries.createUseCase;
  updateUseCase = queries.updateUseCase;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`DELETE FROM code_metrics;`);
  await sql.exec(`DELETE FROM pulse_metrics;`);
  await sql.exec(`DELETE FROM alerts;`);
  await sql.exec(`DELETE FROM pulse_briefings;`);
  await sql.exec(`DELETE FROM code_session_stats;`);
  await sql.exec(`DELETE FROM users;`);
  await sql.exec(`DELETE FROM use_cases;`);
  await sql.exec(`DELETE FROM use_case_activation_weeks;`);
  await setConfigValue('useCasesEnabled', 'false');
});

// Completed week = the week before the current (in-progress) week.
const completedWeekStart = weekStartOf(NOW);
const priorCompletedWeekStart = () => completedWeekStart - WEEK;

function weekStartOf(ts: number): number {
  const d = new Date(ts * 1000);
  const dow = d.getUTCDay();
  const daysSinceMonday = (dow + 6) % 7;
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  return midnight - daysSinceMonday * DAY - WEEK; // one week back = last completed week
}

async function insertUser(id: string) {
  await sql.run(
    `INSERT INTO users (id, email, display_name) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    [id, `${id}@example.com`, id],
  );
}

async function insertCodeOrgWeek(periodStart: number, overrides: Partial<{
  spend_usd: number | null; commit_count: number; pr_count: number;
  active_time_user_s: number; session_count: number;
}> = {}) {
  const v = {
    spend_usd: 100, commit_count: 5, pr_count: 2, active_time_user_s: 3600, session_count: 10,
    ...overrides,
  };
  await sql.run(
    `INSERT INTO code_metrics (
       scope_type, scope_id, period_start, period_end, spend_usd,
       commit_count, pr_count, active_time_user_s, session_count,
       input_tokens, output_tokens, granularity, computed_at
     ) VALUES ('organisation', 'org', ?, ?, ?, ?, ?, ?, ?, 0, 0, 'week', ?)`,
    [periodStart, periodStart + WEEK, v.spend_usd, v.commit_count, v.pr_count, v.active_time_user_s, v.session_count, NOW],
  );
}

async function insertCodeUserWeek(userId: string, periodStart: number, sessionCount: number) {
  await insertUser(userId);
  await sql.run(
    `INSERT INTO code_metrics (
       scope_type, scope_id, period_start, period_end, spend_usd,
       session_count, input_tokens, output_tokens, granularity, computed_at
     ) VALUES ('user', ?, ?, ?, ?, ?, 0, 0, 'week', ?)`,
    [userId, periodStart, periodStart + WEEK, 10, sessionCount, NOW],
  );
}

async function insertCoworkUserWeek(userId: string, periodStart: number, eventCount: number, tier3: number) {
  await insertUser(userId);
  await sql.run(
    `INSERT INTO pulse_metrics (
       scope_type, scope_id, period_start, period_end,
       event_count, tier_1_count, tier_2_count, tier_3_count, granularity, computed_at
     ) VALUES ('user', ?, ?, ?, ?, 0, 0, ?, 'week', ?)`,
    [userId, periodStart, periodStart + WEEK, eventCount, tier3, NOW],
  );
}

async function insertAlert(overrides: Partial<{
  id: string; severity: string; status: string; title: string; generated_at: number; user_id: string | null;
}> = {}) {
  const v = {
    id: `alert-${Math.random()}`, severity: 'high', status: 'open',
    title: 'Something odd', generated_at: completedWeekStart + DAY, user_id: null as string | null,
    ...overrides,
  };
  await sql.run(
    `INSERT INTO alerts (id, alert_type, severity, title, explanation, status, generated_at, user_id)
     VALUES (?, 'anomaly', ?, ?, 'explanation text', ?, ?, ?)`,
    [v.id, v.severity, v.title, v.status, v.generated_at, v.user_id],
  );
}

async function insertBriefing(generatedAt: number, body: string) {
  await sql.run(
    `INSERT INTO pulse_briefings (scope_type, scope_id, period_start, period_end, body, suggestion, model, generated_at)
     VALUES ('organisation', 'code-org', ?, ?, ?, NULL, 'claude-haiku-4-5', ?)`,
    [generatedAt - WEEK, generatedAt, body, generatedAt],
  );
}

describe('buildDigest', () => {
  it('returns null when the DB has no completed-week rows anywhere', async () => {
    const result = await buildDigest(NOW);
    expect(result).toBeNull();
  });

  it('returns null cowork and populated code when only code data exists', async () => {
    await insertCodeOrgWeek(completedWeekStart, { spend_usd: 250, commit_count: 8, pr_count: 3, active_time_user_s: 7200, session_count: 20 });
    await insertCodeUserWeek('user-1', completedWeekStart, 5);
    await insertCodeUserWeek('user-2', completedWeekStart, 0); // inactive this week -> not counted

    const result = await buildDigest(NOW);
    expect(result).not.toBeNull();
    expect(result!.cowork).toBeNull();
    expect(result!.code).not.toBeNull();
    expect(result!.code!.spendUsd).toBe(250);
    expect(result!.code!.commits).toBe(8);
    expect(result!.code!.prs).toBe(3);
    expect(result!.code!.engagedHours).toBe(2.0); // 7200s / 3600
    expect(result!.code!.activeUsers).toBe(1); // only user-1 had session_count > 0
  });

  it('computes full data set with deltas for both surfaces', async () => {
    // Code: prior week 100, completed week 130 -> +30%
    await insertCodeOrgWeek(priorCompletedWeekStart(), { spend_usd: 100, commit_count: 4, pr_count: 1, active_time_user_s: 3600, session_count: 8 });
    await insertCodeOrgWeek(completedWeekStart, { spend_usd: 130, commit_count: 6, pr_count: 2, active_time_user_s: 5400, session_count: 12 });
    await insertCodeUserWeek('user-1', completedWeekStart, 5);
    await insertCodeUserWeek('user-2', completedWeekStart, 3);

    // Cowork: prior week sum=40 (20+20), completed week sum=60 (30+30) -> +50%
    await insertCoworkUserWeek('user-1', priorCompletedWeekStart(), 20, 2);
    await insertCoworkUserWeek('user-2', priorCompletedWeekStart(), 20, 2);
    await insertCoworkUserWeek('user-1', completedWeekStart, 30, 5);
    await insertCoworkUserWeek('user-2', completedWeekStart, 30, 5);

    const result = await buildDigest(NOW);
    expect(result).not.toBeNull();
    expect(result!.weekStart).toBe(completedWeekStart);
    expect(result!.weekEnd).toBe(completedWeekStart + WEEK);

    expect(result!.code).not.toBeNull();
    expect(result!.code!.spendUsd).toBe(130);
    expect(result!.code!.spendDeltaPct).toBeCloseTo(0.3);
    expect(result!.code!.commits).toBe(6);
    expect(result!.code!.prs).toBe(2);
    expect(result!.code!.engagedHours).toBe(1.5);
    expect(result!.code!.activeUsers).toBe(2);
    expect(result!.code!.spendIsPartlyEstimated).toBe(false);
    expect(result!.code!.unpricedModelCount).toBe(0);

    expect(result!.cowork).not.toBeNull();
    expect(result!.cowork!.classifiedEvents).toBe(60);
    expect(result!.cowork!.eventsDeltaPct).toBeCloseTo(0.5);
    expect(result!.cowork!.tier3Count).toBe(10);
    expect(result!.cowork!.tier3DeltaPct).toBeCloseTo(1.5); // prior sum=4 (2+2), current sum=10 (5+5) -> (10-4)/4
    expect(result!.cowork!.activeUsers).toBe(2);
  });

  it('surfaces the highest-severity unacknowledged alert from the completed week', async () => {
    await insertCodeOrgWeek(completedWeekStart);
    await insertAlert({ id: 'a-low', severity: 'low', status: 'open', title: 'Low thing', generated_at: completedWeekStart + DAY });
    await insertAlert({ id: 'a-crit', severity: 'critical', status: 'open', title: 'Critical thing', generated_at: completedWeekStart + 2 * DAY });
    await insertAlert({ id: 'a-high-ack', severity: 'high', status: 'acknowledged', title: 'Acked high', generated_at: completedWeekStart + DAY });
    await insertAlert({ id: 'a-crit-old', severity: 'critical', status: 'open', title: 'Old critical', generated_at: completedWeekStart - DAY }); // out of window

    const result = await buildDigest(NOW);
    expect(result!.anomaly).not.toBeNull();
    expect(result!.anomaly!.title).toBe('Critical thing');
    expect(result!.anomaly!.severity).toBe('critical');
    expect(result!.anomaly!.occurredAt).toBe(completedWeekStart + 2 * DAY);
  });

  it('returns null anomaly when all in-window alerts are acknowledged/resolved/dismissed', async () => {
    await insertCodeOrgWeek(completedWeekStart);
    await insertAlert({ id: 'a1', severity: 'critical', status: 'acknowledged', generated_at: completedWeekStart + DAY });
    await insertAlert({ id: 'a2', severity: 'high', status: 'resolved', generated_at: completedWeekStart + DAY });
    await insertAlert({ id: 'a3', severity: 'high', status: 'dismissed', generated_at: completedWeekStart + DAY });

    const result = await buildDigest(NOW);
    expect(result!.anomaly).toBeNull();
  });

  it('returns null anomaly when the only open alert is outside the week window', async () => {
    await insertCodeOrgWeek(completedWeekStart);
    await insertAlert({ id: 'a1', severity: 'critical', status: 'open', generated_at: completedWeekStart - DAY });
    await insertAlert({ id: 'a2', severity: 'critical', status: 'open', generated_at: completedWeekStart + WEEK + DAY });

    const result = await buildDigest(NOW);
    expect(result!.anomaly).toBeNull();
  });

  it('excludes an alert with an unknown status (fail-closed allowlist, not a blocklist)', async () => {
    await insertCodeOrgWeek(completedWeekStart);
    await insertAlert({ id: 'a-unknown', severity: 'critical', status: 'snoozed', generated_at: completedWeekStart + DAY });

    const result = await buildDigest(NOW);
    // 'snoozed' is neither 'open' nor one of the known acknowledged statuses.
    // A blocklist (!ACKNOWLEDGED_STATUSES.has(status)) would incorrectly
    // treat this as eligible; the fail-closed allowlist (status === 'open')
    // correctly excludes it.
    expect(result!.anomaly).toBeNull();
  });

  it('sets anomaly.userLinked based on whether the winning alert has a user_id', async () => {
    await insertCodeOrgWeek(completedWeekStart);
    await insertAlert({ id: 'a-org-only', severity: 'high', status: 'open', title: 'Org-only alert', generated_at: completedWeekStart + DAY, user_id: null });

    const orgOnlyResult = await buildDigest(NOW);
    expect(orgOnlyResult!.anomaly!.userLinked).toBe(false);

    await sql.exec(`DELETE FROM alerts;`);
    await sql.run(
      `INSERT INTO users (id, email, display_name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)`,
      ['some-user-id', 'some-user@example.com', 'Some User', NOW - 1000, NOW],
    );
    await insertAlert({ id: 'a-user-linked', severity: 'high', status: 'open', title: 'User-linked alert', generated_at: completedWeekStart + DAY, user_id: 'some-user-id' });

    const userLinkedResult = await buildDigest(NOW);
    expect(userLinkedResult!.anomaly!.userLinked).toBe(true);
  });

  it('breaks a same-severity tie by picking the most recently generated alert', async () => {
    await insertCodeOrgWeek(completedWeekStart);
    await insertAlert({ id: 'a-older', severity: 'high', status: 'open', title: 'Older high', generated_at: completedWeekStart + DAY });
    await insertAlert({ id: 'a-newer', severity: 'high', status: 'open', title: 'Newer high', generated_at: completedWeekStart + 2 * DAY });

    const result = await buildDigest(NOW);
    expect(result!.anomaly).not.toBeNull();
    expect(result!.anomaly!.title).toBe('Newer high');
    expect(result!.anomaly!.occurredAt).toBe(completedWeekStart + 2 * DAY);
  });

  it('includes a briefing excerpt only when generated after weekStart', async () => {
    await insertCodeOrgWeek(completedWeekStart);
    await insertBriefing(completedWeekStart + DAY, 'A'.repeat(500));

    const result = await buildDigest(NOW);
    expect(result!.briefingExcerpt).not.toBeNull();
    expect(result!.briefingExcerpt!.length).toBeLessThanOrEqual(400);
    expect(result!.briefingExcerpt).toBe('A'.repeat(400));
  });

  it('omits the briefing excerpt when the stored briefing predates weekStart', async () => {
    await insertCodeOrgWeek(completedWeekStart);
    await insertBriefing(completedWeekStart - DAY, 'stale briefing body');

    const result = await buildDigest(NOW);
    expect(result!.briefingExcerpt).toBeNull();
  });

  it('threads the caller-supplied now into the spend delta, not the real wall clock', async () => {
    // SIMULATED_NOW is one calendar week ahead of real wall-clock NOW, so the
    // "completed week" and "prior completed week" relative to SIMULATED_NOW
    // are a different pair of calendar weeks than relative to real NOW.
    // completedWeekStart (real NOW's completed week) becomes the PRIOR
    // completed week relative to SIMULATED_NOW; a new row one week later
    // becomes the completed week relative to SIMULATED_NOW.
    const SIMULATED_NOW = NOW + WEEK;
    const simulatedCompletedWeek = completedWeekStart + WEEK;

    // If buildDigest's `now` argument failed to reach getWeeklyDelta (old
    // behaviour: getWeeklyDelta always used Math.floor(Date.now()/1000)
    // internally), the delta would instead be computed relative to REAL NOW
    // — comparing completedWeekStart (100) against priorCompletedWeekStart()
    // (no row -> prior null -> pct null) and ignoring simulatedCompletedWeek
    // entirely, since real "now" never sees it as the current week's prior.
    await insertCodeOrgWeek(completedWeekStart, { spend_usd: 100 });
    await insertCodeOrgWeek(simulatedCompletedWeek, { spend_usd: 400 });

    const result = await buildDigest(SIMULATED_NOW);
    expect(result).not.toBeNull();
    expect(result!.weekStart).toBe(simulatedCompletedWeek);
    expect(result!.code!.spendUsd).toBe(400);
    // Correct (simulated-clock) pairing: current=400 (simulatedCompletedWeek),
    // prior=100 (completedWeekStart) -> +300%. The pre-fix behaviour instead
    // yields pct === null (real-clock prior row does not exist), so this
    // assertion fails against the old code — see RED evidence in the fix report.
    expect(result!.code!.spendDeltaPct).toBeCloseTo((400 - 100) / 100);
  });

  it('flags spendIsPartlyEstimated when a session in the week only resolves via normalizeModelId', async () => {
    await insertCodeOrgWeek(completedWeekStart, { spend_usd: 50 });
    await sql.run(
      `INSERT INTO code_session_stats (session_id, user_id, first_at, last_at, models_json, computed_at)
       VALUES ('sess-1', 'user-1', ?, ?, ?, ?)`,
      [completedWeekStart + DAY,
      completedWeekStart + DAY,
      JSON.stringify({ 'us.anthropic.claude-opus-4-6-v1:0': { input: 100, output: 100, cache_creation: 0, cache_read: 0 } }),
      NOW],
    );

    const result = await buildDigest(NOW);
    expect(result!.code!.spendIsPartlyEstimated).toBe(true);
  });

  it('populates useCases.atRisk when useCasesEnabled is true and a use case is at risk', async () => {
    await insertCodeOrgWeek(completedWeekStart);
    await setConfigValue('useCasesEnabled', 'true');
    const uc = await createUseCase({ title: 'Contract triage', keywords: ['x'], status: 'confirmed', ownerUserId: null });
    await updateUseCase(uc.id, { lifecycle: 'at_risk', lifecycleChangedAt: completedWeekStart + DAY });

    const result = await buildDigest(NOW);
    expect(result!.useCases).not.toBeNull();
    expect(result!.useCases!.atRisk.length).toBe(1);
    expect(result!.useCases!.atRisk[0].title).toBe('Contract triage');
    // Transitioned to at_risk inside the reported completed week.
    expect(result!.useCases!.newlyAtRisk).toContain('Contract triage');
  });

  it('leaves useCases null when useCasesEnabled is false', async () => {
    await insertCodeOrgWeek(completedWeekStart);
    await setConfigValue('useCasesEnabled', 'false');
    const uc = await createUseCase({ title: 'Contract triage', keywords: ['x'], status: 'confirmed', ownerUserId: null });
    await updateUseCase(uc.id, { lifecycle: 'at_risk', lifecycleChangedAt: completedWeekStart + DAY });

    const result = await buildDigest(NOW);
    expect(result!.useCases).toBeNull();
  });
});
