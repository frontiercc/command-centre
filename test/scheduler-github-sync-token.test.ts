// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The scheduled GitHub sync is skipped when no token is set. Without one it
// called GitHub anonymously for every mapped repo; private (or made-up demo)
// repos answer 404, so the job recorded a failure every 12 hours. The admin
// Sync Now button is unaffected (it calls runGithubSync directly).
//
// Same harness as test/scheduler-restart-generation.test.ts: every job module
// the scheduler imports is an inert stub, one cycle runs, and the test checks
// whether runGithubSync was reached.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const configStore: Record<string, string> = {};
vi.mock('@/lib/config', () => ({
  getConfigValue: vi.fn((key: string) => (key === 'ingestIntervalSeconds' ? '1' : (configStore[key] ?? ''))),
  setConfigValue: vi.fn(() => Promise.resolve()),
}));

const runGithubSyncMock = vi.fn().mockResolvedValue({ synced: 0, failed: 0, errors: [] });
vi.mock('@/lib/compliance/job', () => ({ runComplianceSyncJob: vi.fn().mockResolvedValue({ skipped: true }) }));

// Outcome recording (lib/ingestion/job-runs.ts) adds a database write after
// each job, which would shift this test's carefully sequenced microtasks; it is
// covered by test/job-runs-pg.test.ts. Here runJob is a plain pass-through.
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
vi.mock('@/lib/pulse/code/github-sync', () => ({ runGithubSync: () => runGithubSyncMock() }));
vi.mock('@/lib/alerts/system-health-alerts', () => ({ runSystemHealthAlertsJob: vi.fn().mockResolvedValue(false) }));
vi.mock('@/lib/pulse/code/briefing', () => ({ generateCodeBriefing: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/pulse/briefings/weekly', () => ({ runWeeklyBriefingJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/pulse/briefings/cio', () => ({ runCioBriefingJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/jobs/user-cleanup', () => ({ runUserCleanup: vi.fn().mockResolvedValue({ deactivated: 0 }) }));
vi.mock('@/lib/digest/schedule', () => ({ runDigestJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/usecases/tracker', () => ({ runUseCaseTrackerJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/usecases/process-mining', () => ({ runProcessMiningJob: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/alerts/finance-alerts', () => ({ runFinanceDriftAlert: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/alerts/slack-sweep', () => ({ runAlertSlackSweepJob: vi.fn().mockResolvedValue(undefined) }));

import { startScheduler, stopScheduler } from '@/lib/ingestion/scheduler';

async function runOneCycle(): Promise<void> {
  startScheduler();
  for (let i = 0; i < 3000; i++) await Promise.resolve();
  stopScheduler();
}

describe('scheduled GitHub sync needs a token', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    runGithubSyncMock.mockClear();
    for (const key of Object.keys(outcomes)) delete outcomes[key];
    for (const key of Object.keys(configStore)) delete configStore[key];
    stopScheduler();
  });

  afterEach(() => {
    stopScheduler();
    vi.useRealTimers();
  });

  it('does not call GitHub when no token is set, and reports the job as switched off', async () => {
    await runOneCycle();
    expect(runGithubSyncMock).not.toHaveBeenCalled();
    expect(outcomes.github_sync).toBe(Symbol.for('job-disabled'));
  });

  it('syncs when a token is set', async () => {
    configStore.githubToken = 'github_pat_test';
    await runOneCycle();
    expect(runGithubSyncMock).toHaveBeenCalledTimes(1);
  });
});
