// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { getConfigValue, setConfigValue } from '@/lib/config';
import { runComplianceSyncJob } from '@/lib/compliance/job';
import { ingestAnalyticsSnapshots } from '@/lib/anthropic/analytics';
import { runRetentionCleanup } from '@/lib/retention/cleanup';
import { runJob, JOB_SKIPPED, JOB_DISABLED } from '@/lib/ingestion/job-runs';
import { deleteExpiredSessions } from '@/lib/db/admin-queries';
import { runClassifierJob } from '@/lib/pulse/classifier';
import { runAuditDrawJob } from '@/lib/pulse/audit/cycle';
import { getDiscoverCache, runSkillsDiscover } from '@/lib/pulse/skills-discover';
import { runHourlyAggregation, runDailyAggregation } from '@/lib/pulse/aggregator';
import { runCoworkSessionAggJob } from '@/lib/pulse/cowork/session-aggregator';
import { runCodeHourlyAggregation } from '@/lib/pulse/code/aggregator';
import { runCodeClassifierJob } from '@/lib/pulse/code/classifier';
import { drainJob, resolveClassifierDrainMaxPasses } from '@/lib/pulse/drain';
import { runGithubSync } from '@/lib/pulse/code/github-sync';
import { generateCodeBriefing } from '@/lib/pulse/code/briefing';
import { runWeeklyBriefingJob } from '@/lib/pulse/briefings/weekly';
import { runCioBriefingJob } from '@/lib/pulse/briefings/cio';
import { runUserCleanup } from '@/lib/jobs/user-cleanup';
import { runDigestJob } from '@/lib/digest/schedule';
import { runUseCaseTrackerJob } from '@/lib/usecases/tracker';
import { runProcessMiningJob } from '@/lib/usecases/process-mining';
import { runFinanceDriftAlert } from '@/lib/alerts/finance-alerts';
import { runAlertSlackSweepJob } from '@/lib/alerts/slack-sweep';
import { runSystemHealthAlertsJob } from '@/lib/alerts/system-health-alerts';

let schedulerRunning = false;
let schedulerTimeout: NodeJS.Timeout | null = null;
// Bumped by every startScheduler()/stopScheduler() call. A runCycle() captures
// the generation it started under; if a stop/start pair (the leader election
// demoting then re-electing this instance) happens while it's still awaiting
// a job, its captured generation is now stale by the time it returns, and it
// must not re-arm the polling timer — otherwise the stale cycle's timer and
// the new cycle's timer both end up scheduled, running two loops in one
// process.
let schedulerGeneration = 0;
// Session descriptions run alongside the cycle, never inside it (see runCycle).
let descriptionRunInFlight = false;
let judgeRunInFlight = false;

/**
 * Wall-clock budget per SCHEDULED classifier drain. Bounds when a pass may
 * START, never mid-pass, so the worst case is this plus one more pass.
 * Code-defined rather than configurable.
 */
const CLASSIFIER_DRAIN_BUDGET_MS = 60_000;

/**
 * Start the polling scheduler. Runs compliance ingestion on the configured interval.
 * Analytics runs once daily (checked on each cycle).
 */
export function startScheduler(): void {
  if (schedulerRunning) return;
  schedulerRunning = true;
  schedulerGeneration++;
  console.log('[Scheduler] Started');
  runCycle();
}

export function stopScheduler(): void {
  schedulerRunning = false;
  schedulerGeneration++;
  if (schedulerTimeout) {
    clearTimeout(schedulerTimeout);
    schedulerTimeout = null;
  }
  console.log('[Scheduler] Stopped');
}

/**
 * Whether to start a session-description run now (hourly; never while one is
 * still in flight). Marks the run as started when it returns true. Never
 * throws: a config read failure just skips this cycle.
 */
async function claimSessionDescriptionRun(): Promise<boolean> {
  try {
    if (descriptionRunInFlight) return false;
    if (await getConfigValue('pulseEnabled') === 'false') return false;
    // The slot also runs the by-hand estimates, so it is
    // skipped only when both jobs are switched off.
    if (await getConfigValue('pulseSessionDescriptionsEnabled') === 'false'
      && await getConfigValue('humanTimeEnabled') !== 'true') return false;
    const lastRun = await getConfigValue('pulseSessionDescriptionsLastRun');
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    if (lastRun && lastRun >= oneHourAgo) return false;
    descriptionRunInFlight = true;
    await setConfigValue('pulseSessionDescriptionsLastRun', new Date().toISOString());
    return true;
  } catch (err) {
    console.error('[Scheduler] Could not check session descriptions:', err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Whether to start a use case judging run now (hourly, never while one is in
 * flight; a changed use case clears the last-run time so the next cycle runs
 * it). Marks the run as started when it returns true. Never throws.
 */
async function claimUseCaseJudgeRun(): Promise<boolean> {
  try {
    if (judgeRunInFlight) return false;
    if (await getConfigValue('useCasesEnabled') !== 'true') return false;
    const lastRun = await getConfigValue('useCaseJudgeLastRun');
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    if (lastRun && lastRun >= oneHourAgo) return false;
    judgeRunInFlight = true;
    await setConfigValue('useCaseJudgeLastRun', new Date().toISOString());
    return true;
  } catch (err) {
    console.error('[Scheduler] Could not check use case judging:', err instanceof Error ? err.message : err);
    return false;
  }
}

async function runCycle(): Promise<void> {
  const generation = schedulerGeneration;
  if (!schedulerRunning) return;

  const intervalMs = parseInt(await getConfigValue('ingestIntervalSeconds') || '60', 10) * 1000;

  // Every job runs through runJob (lib/ingestion/job-runs.ts): a job that was
  // not due returns JOB_SKIPPED and writes nothing; a job that ran records its
  // success or its failure (with the error) in job_runs, so a job that keeps
  // failing is visible instead of only printing to the container log.
  // test/scheduler-job-coverage.test.ts fails if a job bypasses runJob.

  // Compliance sync (interval-gated internally; no-op without a key). A run
  // that reports errors (e.g. a rejected key) counts as a failure.
  await runJob('compliance_sync', 'Compliance sync', async () => {
    const result = await runComplianceSyncJob();
    if (result.skipped) return JOB_SKIPPED;
    const errs = [...(result.chat?.errors ?? []), ...(result.activity?.errors ?? [])];
    if (errs.length > 0) throw new Error(`Compliance sync errors: ${errs.join('; ')}`);
  });

  // A stop/start pair (the leader election demoting then re-electing this
  // instance) may have happened while the compliance sync above was in
  // flight. If so, this cycle's generation is stale and a new cycle has
  // already started under the current generation — exit now rather than run
  // the rest of this cycle's jobs beside it.
  if (generation !== schedulerGeneration) return;

  // Analytics ingestion (once per day — check if we've already run today)
  await runJob('analytics_ingest', 'Analytics ingest', async () => {
    const lastDate = await getConfigValue('analyticsLastDate');
    const today = new Date().toISOString().split('T')[0];
    if (lastDate && lastDate >= today) return JOB_SKIPPED;
    // No key: nothing to do, not a failure. With a key, a failed day (e.g. a
    // rejected key) used to be collected and ignored — now it fails the run.
    if (!(await getConfigValue('anthropicAnalyticsApiKey'))) return JOB_SKIPPED;
    const result = await ingestAnalyticsSnapshots();
    if (result.errors.length > 0) throw new Error(`Analytics API errors: ${result.errors.join('; ')}`);
  });

  // Retention cleanup (once per day — after ingest to avoid table locks)
  await runJob('retention_cleanup', 'Retention cleanup', async () => {
    const lastRun = await getConfigValue('retentionLastRun');
    const oneDayAgo = new Date(Date.now() - 86400 * 1000).toISOString();
    if (lastRun && lastRun >= oneDayAgo) return JOB_SKIPPED;
    console.log('[Scheduler] Running daily retention cleanup...');
    await runRetentionCleanup();
  });

  // OTel user cleanup — soft-deactivate stale users once per day
  await runJob('user_cleanup', 'User cleanup', async () => {
    const lastRun = await getConfigValue('userCleanupLastRun');
    const oneDayAgo = new Date(Date.now() - 86400 * 1000).toISOString();
    if (lastRun && lastRun >= oneDayAgo) return JOB_SKIPPED;
    const result = await runUserCleanup();
    if (result.deactivated > 0) {
      console.log(`[Scheduler] User cleanup: soft-deactivated ${result.deactivated} stale OTel user(s)`);
    }
    await setConfigValue('userCleanupLastRun', new Date().toISOString());
  });

  // Session cleanup (once per day — purge expired sessions from admin_sessions)
  await runJob('session_cleanup', 'Session cleanup', async () => {
    const lastSessionClean = await getConfigValue('sessionCleanupLastRun');
    const oneDayAgo = new Date(Date.now() - 86400 * 1000).toISOString();
    if (lastSessionClean && lastSessionClean >= oneDayAgo) return JOB_SKIPPED;
    const removed = await deleteExpiredSessions();
    if (removed > 0) console.log(`[Scheduler] Session cleanup: removed ${removed} expired session(s)`);
    await setConfigValue('sessionCleanupLastRun', new Date().toISOString());
  });

  // Pulse classifier (every 5 minutes — drains its backlog)
  await runJob('pulse_classifier', 'Pulse classifier', async () => {
    if (await getConfigValue('pulseEnabled') === 'false') return JOB_SKIPPED;
    const lastRun = await getConfigValue('pulseClassifierLastRun');
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    if (lastRun && lastRun >= fiveMinutesAgo) return JOB_SKIPPED;
    console.log('[Scheduler] Running Pulse classifier...');
    const maxPasses = await resolveClassifierDrainMaxPasses();
    const drained = await drainJob(runClassifierJob, {
      maxPasses,
      budgetMs: CLASSIFIER_DRAIN_BUDGET_MS,
      shouldContinue: () => generation === schedulerGeneration,
    });
    await setConfigValue('pulseClassifierLastRun', new Date().toISOString());
    // A failed model call (rejected key, outage) is a failed run, not a quiet one.
    if (drained.apiError) throw new Error(`Classifier API call failed: ${drained.apiError}`);
  });

  // Pulse aggregator — hourly
  await runJob('pulse_hourly_aggregation', 'Pulse hourly aggregation', async () => {
    if (await getConfigValue('pulseEnabled') === 'false') return JOB_SKIPPED;
    const lastRun = await getConfigValue('pulseAggregatorLastRun');
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    if (lastRun && lastRun >= oneHourAgo) return JOB_SKIPPED;
    console.log('[Scheduler] Running Pulse hourly aggregation...');
    await runHourlyAggregation();
  });

  // Cowork session-stats aggregation — hourly (cadence-guarded inside the
  // job, mirrors the Use Cases tracker pattern; this was never scheduled
  // before — its only caller was the on-demand /api/pulse/cowork/aggregate
  // route, so cowork_session_stats stayed near-empty on every deployment)
  await runJob('cowork_session_aggregation', 'Cowork session-stats aggregation', async () => {
    await runCoworkSessionAggJob();
  });

  // Session descriptions for the Work Pulse frontier boxes — hourly.
  // STARTED, NOT AWAITED: a first fill can be hundreds of calls,
  // one at a time, and must not hold up the jobs after it. runJob still records
  // the real outcome when the run ends, so a failure shows on System health.
  // Dynamic import: the job calls queueAiCall, which lives in this module.
  if (await claimSessionDescriptionRun()) {
    void runJob('pulse_session_descriptions', 'Cowork session descriptions', async () => {
      const { runSessionDescriptionJob } = await import('@/lib/pulse/session-descriptions');
      const r = await runSessionDescriptionJob();
      if (r.written || r.failed) {
        const why = r.reasons ? Object.entries(r.reasons).map(([k, n]) => `${k} ${n}`).join(', ') : '';
        console.log(`[Scheduler] Session descriptions: ${r.written} written, ${r.failed} not accepted${why ? ` (${why})` : ''}`);
      }
      // Cowork by-hand estimates for Tier 2/3 sessions (self-gated on humanTimeEnabled, the Cowork switch).
      const { runSessionEstimateJob } = await import('@/lib/pulse/session-estimates');
      const e = await runSessionEstimateJob();
      if (e.written || e.refused) console.log(`[Scheduler] Session estimates: ${e.written} written, ${e.refused} not accepted`);
      if (r.apiError) throw new Error(`Session description model call failed: ${r.apiError}`);
      if (e.apiError) throw new Error(`Session estimate model call failed: ${e.apiError}`);
    }).finally(() => { descriptionRunInFlight = false; });
  }

  // Classifier accuracy audit — draw the prior month's sample. Idempotent
  // per period; a daily cadence guard keeps it cheap. The draw only creates the
  // sample; human review + scoring happen in the Audit tab.
  await runJob('classifier_audit_draw', 'Classifier audit draw', async () => {
    if (await getConfigValue('pulseEnabled') === 'false') return JOB_SKIPPED;
    const lastRun = await getConfigValue('pulseAuditLastRun');
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    if (lastRun && lastRun >= oneDayAgo) return JOB_SKIPPED;
    const result = await runAuditDrawJob();
    if (result.drawn) console.log(`[Scheduler] Drew classifier audit sample for ${result.period}`);
    await setConfigValue('pulseAuditLastRun', new Date().toISOString());
  });

  // Developer Pulse aggregator — hourly (deterministic, no classifier)
  await runJob('code_hourly_aggregation', 'Developer Pulse aggregation', async () => {
    if (await getConfigValue('codePulseEnabled') === 'false') return JOB_SKIPPED;
    const lastRun = await getConfigValue('codeAggregatorLastRun');
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    if (lastRun && lastRun >= oneHourAgo) return JOB_SKIPPED;
    console.log('[Scheduler] Running Developer Pulse hourly aggregation...');
    await runCodeHourlyAggregation();
  });

  // Use Cases incremental tracker — cadence-configurable (default hourly)
  await runJob('use_case_tracker', 'Use case tracker', async () => {
    await runUseCaseTrackerJob();
  });

  // Use case session judging: which use cases each finished
  // session is doing. STARTED, NOT AWAITED, like session descriptions: a first
  // fill can be dozens of calls one at a time. runJob records the real outcome,
  // so a model failure shows on System health.
  if (await claimUseCaseJudgeRun()) {
    void runJob('use_case_session_judge', 'Use case session judging', async () => {
      const { runUseCaseJudgeJob } = await import('@/lib/usecases/session-judge');
      const r = await runUseCaseJudgeJob();
      if (r.considered) console.log(`[Scheduler] Use case judging: ${r.judged} judged, ${r.matchedSessions} matched, ${r.failedBatches} batch(es) unreadable`);
      if (r.apiError) throw new Error(`Use case judging model call failed: ${r.apiError}`);
      if (r.failedBatches) throw new Error(`Use case judging: ${r.failedBatches} batch(es) came back unreadable or cut off; retried next run`);
    }).finally(() => { judgeRunInFlight = false; });
  }

  // Department process mining — scheduled LLM synthesis (cadence-guarded inside the job)
  await runJob('process_mining', 'Process mining job', async () => {
    await runProcessMiningJob();
  });

  // FinOps v2 — reconciliation-drift alert (self-guards on chargebackEnabled).
  // Not awaited, as before; its outcome is still recorded.
  void runJob('finance_drift_alert', 'FinOps reconciliation-drift alert', async () => {
    await runFinanceDriftAlert();
  });

  // Developer Pulse session-digest classifier — opt-in judged layer, every 30 min
  // (drains its backlog)
  await runJob('code_classifier', 'Developer Pulse classifier', async () => {
    const codeClassifierEnabled = await getConfigValue('codePulseEnabled') !== 'false'
      && await getConfigValue('codeClassifierEnabled') !== 'false';
    if (!codeClassifierEnabled) return JOB_SKIPPED;
    const lastRun = await getConfigValue('codeClassifierLastRun');
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    if (lastRun && lastRun >= thirtyMinutesAgo) return JOB_SKIPPED;
    console.log('[Scheduler] Running Developer Pulse session classifier...');
    const maxPasses = await resolveClassifierDrainMaxPasses();
    const drained = await drainJob(runCodeClassifierJob, {
      maxPasses,
      budgetMs: CLASSIFIER_DRAIN_BUDGET_MS,
      shouldContinue: () => generation === schedulerGeneration,
    });
    await setConfigValue('codeClassifierLastRun', new Date().toISOString());
    if (drained.apiError) throw new Error(`Classifier API call failed: ${drained.apiError}`);
    // Human time backlog: one batch of classified Tier 2/3
    // sessions from the last 30 days still missing a by-hand estimate — the
    // window the cards show, so a fresh deploy fills in with no script.
    if (await (await import('@/lib/pulse/human-time-flags')).humanTimeOn('code')) {
      const { estimateClassifiedCodeSessions } = await import('@/lib/pulse/code/classifier');
      const est = await estimateClassifiedCodeSessions(new Set(), undefined, { sinceS: Math.floor(Date.now() / 1000) - 30 * 86400 });
      if (est.attempted.length) console.log(`[Scheduler] Code human-time backlog: ${est.written} of ${est.attempted.length} estimated`);
      if (est.apiError) throw new Error(`Code human-time estimate call failed: ${est.apiError}`);
    }
  });

  // Developer Pulse weekly briefing — Sundays at or after 22:00, once per week
  await runJob('code_weekly_briefing', 'Code briefing', async () => {
    if (await getConfigValue('codePulseEnabled') === 'false' || !(await getConfigValue('anthropicAiApiKey'))) return JOB_SKIPPED;
    const d = new Date();
    if (d.getDay() !== 0 || d.getHours() < 22) return JOB_SKIPPED;
    const lastRun = await getConfigValue('codeBriefingLastRun');
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
    if (lastRun && lastRun >= sixDaysAgo) return JOB_SKIPPED;
    console.log('[Scheduler] Generating weekly Developer Pulse briefing...');
    // Once a week, pass or fail. It used to retry every cycle until midnight
    // after a failure; now runJob records the failure and last week's stays.
    await generateCodeBriefing().finally(() => setConfigValue('codeBriefingLastRun', new Date().toISOString()));
  });

  // GitHub overlay sync — every 12 hours (no-op when no repos are mapped).
  // Off with no token: unauthenticated calls 404 on private repos and
  // recorded a failure every run. JOB_DISABLED also clears the old failures
  // from System health. Sync Now still works without one.
  await runJob('github_sync', 'GitHub overlay sync', async () => {
    if (await getConfigValue('codePulseEnabled') === 'false') return JOB_SKIPPED;
    if (!(await getConfigValue('githubToken'))) return JOB_DISABLED;
    const lastRun = await getConfigValue('githubSyncLastRun');
    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    if (lastRun && lastRun >= twelveHoursAgo) return JOB_SKIPPED;
    const result = await runGithubSync();
    if (result.errors.length > 0) throw new Error(`GitHub API errors: ${result.errors.join('; ')}`);
  });

  // Pulse aggregator — daily (function-level metrics)
  await runJob('pulse_daily_aggregation', 'Pulse daily aggregation', async () => {
    if (await getConfigValue('pulseEnabled') === 'false') return JOB_SKIPPED;
    const lastRun = await getConfigValue('pulseAggregatorDailyLastRun');
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    if (lastRun && lastRun >= oneDayAgo) return JOB_SKIPPED;
    console.log('[Scheduler] Running Pulse daily aggregation...');
    await runDailyAggregation();
  });

  // Pulse weekly briefing — Sunday at or after 22:00 server time, once per week
  await runJob('pulse_weekly_briefing', 'Pulse weekly briefing', async () => {
    if (await getConfigValue('pulseEnabled') === 'false') return JOB_SKIPPED;
    const now = new Date();
    if (now.getDay() !== 0 || now.getHours() < 22) return JOB_SKIPPED;
    // Check we haven't already run this Sunday
    const lastRun = await getConfigValue('pulseWeeklyBriefingLastRun');
    const thisSundayStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
    if (lastRun && lastRun >= thisSundayStr) return JOB_SKIPPED;
    console.log('[Scheduler] Running Pulse weekly briefing job...');
    const r = await runWeeklyBriefingJob();
    // Mark the week done BEFORE reporting failures: a thrown error must not make
    // the next cycle regenerate every user's briefing again.
    await setConfigValue('pulseWeeklyBriefingLastRun', thisSundayStr);
    if (r.failed > 0) {
      throw new Error(`${r.failed} of ${r.users} weekly briefings failed (${r.rejected} refused by the number check); those people keep last week's briefing`);
    }
  });

  // Pulse CIO briefing — 1st of month, once per month
  await runJob('pulse_cio_briefing', 'Pulse CIO briefing', async () => {
    if (await getConfigValue('pulseEnabled') === 'false') return JOB_SKIPPED;
    const now = new Date();
    if (now.getDate() !== 1) return JOB_SKIPPED;
    const lastRun = await getConfigValue('pulseCioBriefingLastRun');
    const thisMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    if (lastRun && lastRun >= thisMonthStr) return JOB_SKIPPED;
    console.log('[Scheduler] Running Pulse CIO briefing job...');
    // Once a month, pass or fail: a failure is recorded by runJob, not retried every minute.
    await runCioBriefingJob().finally(() => setConfigValue('pulseCioBriefingLastRun', thisMonthStr));
  });

  // Weekly Exec Digest — Monday at or after the configured send hour UTC, once per week
  // (shouldSendDigest/runDigestJob own the day/hour/once-per-week gating and
  // their own logging — mirrors the other briefing jobs' guard structure,
  // just encapsulated in lib/digest/schedule.ts for unit testability.)
  await runJob('weekly_digest', 'Weekly Exec Digest', async () => {
    await runDigestJob();
  });

  // System-health alerts — hourly, from job_runs (key rejected, job failing,
  // retention stale). Runs before the Slack sweep so a new alert goes out in
  // the same cycle.
  await runJob('system_health_alerts', 'System health alerts', async () => {
    if (!(await runSystemHealthAlertsJob())) return JOB_SKIPPED;
  });

  // High-Priority Alerts -> Slack — hourly sweep (self-guards its own cadence + cursor inside)
  await runJob('alerts_slack_sweep', 'Alerts Slack sweep', async () => {
    await runAlertSlackSweepJob();
  });

  // Skills discover — weekly refresh (any day, once the cache is 7+ days old)
  await runJob('skills_discover', 'Skills discover', async () => {
    const { is_stale } = await getDiscoverCache();
    if (!is_stale) return JOB_SKIPPED;
    if (!(await getConfigValue('anthropicAiApiKey'))) return JOB_SKIPPED;
    console.log('[Scheduler] Running weekly skills discover refresh...');
    await runSkillsDiscover();
  });

  // Schedule next cycle — but only if this cycle's generation is still the
  // current one. A stop/start pair that happened while this cycle was in
  // flight (see the schedulerGeneration comment above) bumped the generation;
  // a cycle that started before that pair must not re-arm the loop.
  if (schedulerRunning && generation === schedulerGeneration) {
    schedulerTimeout = setTimeout(runCycle, intervalMs);
  }
}

/**
 * Exponential backoff utility for API calls with rate limits.
 */
export async function withBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Check for rate limit (429) or server error (5xx)
      const isRetryable =
        lastError.message.includes('429') ||
        lastError.message.includes('500') ||
        lastError.message.includes('502') ||
        lastError.message.includes('503');

      if (!isRetryable || attempt === maxRetries) {
        throw lastError;
      }

      const delay = baseDelayMs * Math.pow(2, attempt);
      console.log(`[Backoff] Attempt ${attempt + 1} failed, retrying in ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

/**
 * AI call queue — limit concurrent Claude API calls to 3.
 */
let activeCalls = 0;
const callQueue: Array<() => void> = [];

export async function queueAiCall<T>(fn: () => Promise<T>): Promise<T> {
  if (activeCalls >= 3) {
    await new Promise<void>(resolve => callQueue.push(resolve));
  }

  activeCalls++;
  try {
    return await fn();
  } finally {
    activeCalls--;
    const next = callQueue.shift();
    if (next) next();
  }
}
