// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The AI anomaly detector (risk scoring) runs once a day from the scheduler.
// Before this it ran only when an admin pressed Analyse. It needs a Claude API
// key, runs at most once a day, and is started rather than awaited, so a slow
// model call never holds up the rest of the cycle.
//
// Same harness as test/scheduler-github-sync-token.test.ts: every job module
// the scheduler imports is an inert stub and one cycle runs.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const configStore: Record<string, string> = {};
const setConfigValueMock = vi.fn((key: string, value: string) => { configStore[key] = value; return Promise.resolve(); });
vi.mock('@/lib/config', () => ({
  getConfigValue: vi.fn((key: string) => (key === 'ingestIntervalSeconds' ? '1' : (configStore[key] ?? ''))),
  setConfigValue: (key: string, value: string) => setConfigValueMock(key, value),
  getAllConfig: vi.fn(async () => ({
    riskAlertAnomalyEnabled: configStore.riskAlertAnomalyEnabled !== 'false',
    riskAlertPolicyEnabled: configStore.riskAlertPolicyEnabled !== 'false',
    riskAlertAdoptionEnabled: configStore.riskAlertAdoptionEnabled !== 'false',
    riskAlertRiskEnabled: configStore.riskAlertRiskEnabled !== 'false',
  })),
}));

const runAnomalyDetectionMock = vi.fn();
vi.mock('@/lib/anthropic/ai', () => ({ runAnomalyDetection: () => runAnomalyDetectionMock() }));
const slackSweepMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/compliance/job', () => ({ runComplianceSyncJob: vi.fn().mockResolvedValue({ skipped: true }) }));

const outcomes: Record<string, unknown> = {};
vi.mock('@/lib/ingestion/job-runs', () => ({
  JOB_SKIPPED: Symbol.for('job-skipped'),
  JOB_DISABLED: Symbol.for('job-disabled'),
  runJob: async (name: string, _label: string, fn: () => Promise<unknown>) => { try { outcomes[name] = await fn(); } catch { /* recorded elsewhere */ } },
}));

// ── Every other job module: inert stubs ──
// ingestAnalyticsSnapshots is the job that runs right AFTER the compliance
// sync — it's used below to prove a stale cycle exits before reaching it.
const ingestAnalyticsSnapshotsMock = vi.fn().mockResolvedValue({ snapshotsUpserted: 0, errors: [] });
vi.mock('@/lib/anthropic/analytics', () => ({ ingestAnalyticsSnapshots: () => ingestAnalyticsSnapshotsMock() }));
vi.mock('@/lib/retention/cleanup', () => ({ runRetentionCleanup: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/db/admin-queries', () => ({ deleteExpiredSessions: vi.fn().mockResolvedValue(0) }));
vi.mock('@/lib/pulse/classifier', () => ({ runClassifierJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/pulse/audit/cycle', () => ({ runAuditDrawJob: vi.fn().mockResolvedValue({ drawn: false, period: '' }) }));
vi.mock('@/lib/pulse/skills-discover', () => ({
  getDiscoverCache: vi.fn().mockResolvedValue({ is_stale: false }),
  runSkillsDiscover: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/pulse/aggregator', () => ({
  runHourlyAggregation: vi.fn().mockResolvedValue(undefined),
  runDailyAggregation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/pulse/cowork/session-aggregator', () => ({ runCoworkSessionAggJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/pulse/session-descriptions', () => ({ runSessionDescriptionJob: vi.fn().mockResolvedValue({ written: 0, failed: 0, skipped: false }) }));
vi.mock('@/lib/pulse/code/aggregator', () => ({ runCodeHourlyAggregation: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/pulse/code/classifier', () => ({ runCodeClassifierJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/pulse/code/github-sync', () => ({ runGithubSync: vi.fn().mockResolvedValue({ synced: 0, failed: 0, errors: [] }) }));
vi.mock('@/lib/alerts/system-health-alerts', () => ({ runSystemHealthAlertsJob: vi.fn().mockResolvedValue(false) }));
vi.mock('@/lib/pulse/code/briefing', () => ({ generateCodeBriefing: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/pulse/briefings/weekly', () => ({ runWeeklyBriefingJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/pulse/briefings/cio', () => ({ runCioBriefingJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/jobs/user-cleanup', () => ({ runUserCleanup: vi.fn().mockResolvedValue({ deactivated: 0 }) }));
vi.mock('@/lib/digest/schedule', () => ({ runDigestJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/usecases/tracker', () => ({ runUseCaseTrackerJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/usecases/process-mining', () => ({ runProcessMiningJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/alerts/finance-alerts', () => ({ runFinanceDriftAlert: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/alerts/slack-sweep', () => ({ runAlertSlackSweepJob: () => slackSweepMock() }));

import { startScheduler, stopScheduler } from '@/lib/ingestion/scheduler';

async function runOneCycle(): Promise<void> {
  startScheduler();
  for (let i = 0; i < 3000; i++) await Promise.resolve();
  stopScheduler();
}

describe('daily anomaly detection', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    runAnomalyDetectionMock.mockReset().mockResolvedValue([]);
    slackSweepMock.mockClear();
    setConfigValueMock.mockClear();
    for (const key of Object.keys(outcomes)) delete outcomes[key];
    for (const key of Object.keys(configStore)) delete configStore[key];
    stopScheduler();
  });

  afterEach(() => {
    stopScheduler();
    vi.useRealTimers();
  });

  it('does not run without a Claude API key', async () => {
    await runOneCycle();
    expect(slackSweepMock).toHaveBeenCalled(); // the cycle reached its end
    expect(runAnomalyDetectionMock).not.toHaveBeenCalled();
    expect(configStore.anomalyDetectionLastRun).toBeUndefined();
  });

  it('runs once when a key is set and it has not run today, and records the run', async () => {
    configStore.anthropicAiApiKey = 'sk-test';
    await runOneCycle();
    await vi.waitFor(() => expect(runAnomalyDetectionMock).toHaveBeenCalledTimes(1));
    expect(configStore.anomalyDetectionLastRun).toBeTruthy();
  });

  it('does not run again within a day', async () => {
    configStore.anthropicAiApiKey = 'sk-test';
    configStore.anomalyDetectionLastRun = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    await runOneCycle();
    expect(runAnomalyDetectionMock).not.toHaveBeenCalled();
  });

  it('runs again once a day has passed', async () => {
    configStore.anthropicAiApiKey = 'sk-test';
    configStore.anomalyDetectionLastRun = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    await runOneCycle();
    await vi.waitFor(() => expect(runAnomalyDetectionMock).toHaveBeenCalledTimes(1));
  });

  it('is not awaited: a slow run never holds up the cycle', async () => {
    configStore.anthropicAiApiKey = 'sk-test';
    runAnomalyDetectionMock.mockReturnValue(new Promise(() => { /* never settles */ }));
    await runOneCycle();
    await vi.waitFor(() => expect(runAnomalyDetectionMock).toHaveBeenCalledTimes(1));
    expect(slackSweepMock).toHaveBeenCalled();
  });

  it('makes no model call when every alert type it raises is switched off', async () => {
    configStore.anthropicAiApiKey = 'sk-test';
    configStore.riskAlertAnomalyEnabled = 'false';
    configStore.riskAlertPolicyEnabled = 'false';
    configStore.riskAlertAdoptionEnabled = 'false';
    configStore.riskAlertRiskEnabled = 'false';
    await runOneCycle();
    expect(runAnomalyDetectionMock).not.toHaveBeenCalled();
  });
});
