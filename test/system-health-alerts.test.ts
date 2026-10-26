// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// System-health alert rules — pure planner, no database.
import { describe, it, expect } from 'vitest';
import { planSystemHealthAlerts, looksLikeRejectedKey, type JobRunRow } from '@/lib/alerts/system-health-alerts';
import { drainJob } from '@/lib/pulse/drain';

const NOW = 1_790_000_000;
const row = (o: Partial<JobRunRow> & { job_name: string }): JobRunRow => ({
  last_succeeded_at: null, last_failed_at: null, last_error: null, consecutive_failures: 0, ...o,
});

describe('looksLikeRejectedKey', () => {
  it.each([
    ['Compliance sync errors: HTTP 401', true],
    ['GitHub API errors: acme/api commits: HTTP 403', true],
    ['401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', true],
    ['Analytics API error 500: upstream', false],
    ['bind message has 4401 parameter formats', false],
    [null, false],
  ])('%s → %s', (text, expected) => {
    expect(looksLikeRejectedKey(text)).toBe(expected);
  });
});

describe('planSystemHealthAlerts', () => {
  it('a frequent job alerts at two failures in a row, not one', () => {
    expect(planSystemHealthAlerts([row({ job_name: 'use_case_tracker', consecutive_failures: 1, last_error: 'boom' })], NOW)).toEqual([]);
    const p = planSystemHealthAlerts([row({ job_name: 'use_case_tracker', consecutive_failures: 2, last_error: 'boom' })], NOW);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ rule: 'job_failing', subject: 'use_case_tracker', title: 'Scheduled job failing: Use case tracker' });
    expect(p[0].explanation).toContain('boom');
  });

  it('a daily or slower job alerts at its first failure', () => {
    const p = planSystemHealthAlerts([row({ job_name: 'retention_cleanup', consecutive_failures: 1, last_error: 'bind message' })], NOW);
    expect(p.map(x => x.rule)).toEqual(['job_failing']);
  });

  it('a rejected key raises the key alert instead of the job alert, even at one failure', () => {
    const p = planSystemHealthAlerts([row({ job_name: 'pulse_classifier', consecutive_failures: 1, last_error: 'Classifier API call failed: 401 authentication_error' })], NOW);
    expect(p).toEqual([expect.objectContaining({ rule: 'key_rejected', subject: 'pulse_classifier', title: 'Anthropic API key rejected' })]);
  });

  it('a 401 on a job that uses no key is just a failing job', () => {
    const p = planSystemHealthAlerts([row({ job_name: 'use_case_tracker', consecutive_failures: 2, last_error: 'HTTP 401' })], NOW);
    expect(p.map(x => x.rule)).toEqual(['job_failing']);
  });

  it('retention stale: last success over 26 hours ago while not failing', () => {
    expect(planSystemHealthAlerts([row({ job_name: 'retention_cleanup', last_succeeded_at: NOW - 25 * 3600 })], NOW)).toEqual([]);
    const p = planSystemHealthAlerts([row({ job_name: 'retention_cleanup', last_succeeded_at: NOW - 30 * 3600 })], NOW);
    expect(p).toEqual([expect.objectContaining({ rule: 'retention_stale', subject: 'retention_cleanup' })]);
    expect(p[0].explanation).toContain('30 hours');
  });

  it('retention failing raises the job alert only, not stale as well', () => {
    const p = planSystemHealthAlerts([row({ job_name: 'retention_cleanup', last_succeeded_at: NOW - 40 * 3600, consecutive_failures: 1, last_error: 'x' })], NOW);
    expect(p.map(x => x.rule)).toEqual(['job_failing']);
  });

  it('four or more failing jobs raise one combined alert; rejected keys stay separate', () => {
    const failing = ['use_case_tracker', 'pulse_hourly_aggregation', 'code_hourly_aggregation', 'retention_cleanup']
      .map(n => row({ job_name: n, consecutive_failures: 2, last_error: 'connect ECONNREFUSED' }));
    const key = row({ job_name: 'github_sync', consecutive_failures: 1, last_error: 'HTTP 401' });
    const p = planSystemHealthAlerts([...failing, key], NOW);
    expect(p.map(x => x.rule)).toEqual(['key_rejected', 'jobs_failing']);
    const combined = p.find(x => x.rule === 'jobs_failing')!;
    expect(combined).toMatchObject({ subject: 'many', title: '4 scheduled jobs failing' });
    expect(combined.explanation).toContain('Use case tracker, Work Pulse hourly aggregation, Developer Pulse aggregation, Retention cleanup');
    expect(combined.explanation).toContain('connect ECONNREFUSED');
  });

  it('three failing jobs are still raised one by one', () => {
    const p = planSystemHealthAlerts(['use_case_tracker', 'pulse_hourly_aggregation', 'code_hourly_aggregation']
      .map(n => row({ job_name: n, consecutive_failures: 2, last_error: 'x' })), NOW);
    expect(p.map(x => x.rule)).toEqual(['job_failing', 'job_failing', 'job_failing']);
  });

  it('healthy jobs and a never-run retention raise nothing', () => {
    expect(planSystemHealthAlerts([
      row({ job_name: 'pulse_classifier', last_succeeded_at: NOW - 60 }),
      row({ job_name: 'retention_cleanup' }),
    ], NOW)).toEqual([]);
  });
});

describe('drainJob apiError', () => {
  it('carries a failed model call out of the drain', async () => {
    const passes = [
      { selected: 10, classified: 10, failed: 0 },
      { selected: 10, classified: 0, failed: 10, apiError: '401 authentication_error' },
    ];
    let i = 0;
    const r = await drainJob(async () => passes[i++], { maxPasses: 5 });
    expect(r).toEqual({ passes: 2, classified: 10, failed: 10, apiError: '401 authentication_error' });
  });

  it('has no apiError when every call succeeded', async () => {
    const r = await drainJob(async () => ({ selected: 0, classified: 0, failed: 0 }), { maxPasses: 5 });
    expect(r).toEqual({ passes: 1, classified: 0, failed: 0 });
  });
});
