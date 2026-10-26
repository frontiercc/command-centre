// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Regression test for a mid-cycle stop/start race: the scheduler leader
// election (lib/db/scheduler-lock.ts) can demote an instance (stopScheduler())
// while a cycle is awaiting a slow job, then re-elect it (startScheduler())
// before that cycle returns. The stale cycle must not re-arm the polling
// timer when it finally finishes — otherwise two loops end up running in one
// process, which is exactly the duplicate-job-firing bug this feature exists
// to prevent.
//
// lib/ingestion/scheduler.ts imports ~25 job modules that touch the database
// at module load time, so every one of them is mocked to an inert stub here
// (pattern borrowed from test/digest-scheduler.test.ts's @/lib/config mock).
// Only runComplianceSyncJob — the first job runCycle() awaits — is made
// controllable, via a fresh deferred promise per call, so the test can hold
// a cycle "in flight" and resume it on demand.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── @/lib/config ──
// The analytics job (the marker below) skips without a key since system-health part 4.
const configStore: Record<string, string> = { anthropicAnalyticsApiKey: 'test-key' };
vi.mock('@/lib/config', () => ({
  getConfigValue: vi.fn((key: string) => (key === 'ingestIntervalSeconds' ? '1' : (configStore[key] ?? ''))),
  setConfigValue: vi.fn((_key: string, _value: string) => Promise.resolve()),
}));

// ── Controllable first job: runComplianceSyncJob ──
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const complianceDeferreds: Deferred<{ skipped: boolean }>[] = [];
const runComplianceSyncJobMock = vi.fn(() => {
  const d = makeDeferred<{ skipped: boolean }>();
  complianceDeferreds.push(d);
  return d.promise;
});
vi.mock('@/lib/compliance/job', () => ({
  runComplianceSyncJob: () => runComplianceSyncJobMock(),
}));

// Outcome recording (lib/ingestion/job-runs.ts) adds a database write after
// each job, which would shift this test's carefully sequenced microtasks; it is
// covered by test/job-runs-pg.test.ts. Here runJob is a plain pass-through.
vi.mock('@/lib/ingestion/job-runs', () => ({
  JOB_SKIPPED: Symbol('job-skipped'),
  runJob: async (_name: string, _label: string, fn: () => Promise<unknown>) => { try { await fn(); } catch { /* recorded elsewhere */ } },
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
vi.mock('@/lib/alerts/slack-sweep', () => ({ runAlertSlackSweepJob: vi.fn().mockResolvedValue(undefined) }));

import { startScheduler, stopScheduler } from '@/lib/ingestion/scheduler';

/** Flush the real microtask queue (fake timers here only fake setTimeout/clearTimeout). */
async function flush(times = 300): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('scheduler restart generation guard', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    complianceDeferreds.length = 0;
    runComplianceSyncJobMock.mockClear();
    ingestAnalyticsSnapshotsMock.mockClear();
    for (const key of Object.keys(configStore)) delete configStore[key];
    configStore.anthropicAnalyticsApiKey = 'test-key';
    // Clean slate regardless of what a prior test left running.
    stopScheduler();
  });

  afterEach(() => {
    stopScheduler();
    vi.useRealTimers();
  });

  it('a cycle started before a stop/start pair must not re-arm the loop', async () => {
    // Cycle A starts and parks on the first compliance-sync call.
    startScheduler();
    await flush();
    expect(complianceDeferreds.length).toBe(1);

    // Demote then re-elect while cycle A is still in flight — exactly what
    // the leader election does across a lock loss/regain.
    stopScheduler();
    startScheduler();
    await flush();

    // Cycle B has started and is parked on its own compliance-sync call.
    expect(complianceDeferreds.length).toBe(2);

    // Let cycle A finish. It is stale (its generation predates the stop/start
    // pair) and must exit right after the compliance sync — never reaching
    // ingestAnalyticsSnapshots, the next job in its chain — rather than
    // running the rest of its job list alongside cycle B.
    complianceDeferreds[0].resolve({ skipped: true });
    await flush();
    expect(ingestAnalyticsSnapshotsMock).not.toHaveBeenCalled();

    // Cycle A captured the generation from before the stop/start pair, which
    // is now stale — it must not arm a timer for itself.
    expect(vi.getTimerCount()).toBe(0);

    // Let cycle B finish — it captured the current generation, so it runs its
    // full job list (incl. ingestAnalyticsSnapshots) and is the only cycle
    // allowed to keep the loop going.
    complianceDeferreds[1].resolve({ skipped: true });
    await flush();

    expect(ingestAnalyticsSnapshotsMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('stopScheduler while a cycle is in flight leaves zero timers once it resolves', async () => {
    startScheduler();
    await flush();
    expect(complianceDeferreds.length).toBe(1);

    stopScheduler();

    complianceDeferreds[0].resolve({ skipped: true });
    await flush();

    expect(vi.getTimerCount()).toBe(0);
  });
});
