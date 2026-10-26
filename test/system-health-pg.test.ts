// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// System health panel data, on
// Postgres.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const config: Record<string, string> = {};
vi.mock('@/lib/config', () => ({
  getConfigValue: async (k: string) => config[k] ?? '',
  getUnreadableSecretKeys: async () => unreadable,
}));
const unreadable: string[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let cleanup: () => Promise<void>;
let sqlTag: typeof import('drizzle-orm').sql;
let health: typeof import('@/lib/health/system-health');
let catalog: typeof import('@/lib/health/job-catalog');

async function run(text: string): Promise<Array<Record<string, unknown>>> {
  const r = await db.execute(sqlTag.raw(text));
  return (r.rows ?? r) as Array<Record<string, unknown>>;
}

const NOW = 1_790_000_000;

describe('getSystemHealth (postgres)', () => {
  beforeAll(async () => {
    const { createTestDbClient } = await import('./helpers/db');
    const c = await createTestDbClient('postgres');
    db = c.client; cleanup = c.cleanup;
    sqlTag = (await import('drizzle-orm')).sql;
    health = await import('@/lib/health/system-health');
    catalog = await import('@/lib/health/job-catalog');
  }, 180_000);
  afterAll(async () => { if (cleanup) await cleanup(); });
  beforeEach(async () => {
    for (const k of Object.keys(config)) delete config[k];
    unreadable.length = 0;
    await run(`DELETE FROM job_runs`);
    await run(`DELETE FROM error_events`);
    await run(`DELETE FROM cowork_messages`);
    await run(`DELETE FROM code_otel_metrics`);
    await run(`DELETE FROM chat_messages`);
  });

  it('an empty hub reads not yet run and nothing received — never healthy', async () => {
    const h = await health.getSystemHealth(NOW);
    expect(h.jobs).toHaveLength(catalog.JOB_CATALOG.length);
    expect(h.jobs.every(j => j.status === 'not_run')).toBe(true);
    expect(h.surfaces.map(s => s.key)).toEqual(['cowork', 'code', 'code_metrics']);
    expect(h.surfaces.every(s => s.lastEventAt === null)).toBe(true);
    expect(h.ingestFailures).toEqual({ last24h: 0, last7d: 0, lastAt: null, lastMessage: null });
    expect(h.integrations).toEqual([]);
  });

  it('reads job outcomes, and keeps a recorded job the catalogue does not know', async () => {
    await run(`INSERT INTO job_runs (job_name, last_succeeded_at, consecutive_failures) VALUES ('retention_cleanup', ${NOW - 100}, 0)`);
    await run(`INSERT INTO job_runs (job_name, last_succeeded_at, last_failed_at, last_error, consecutive_failures)
               VALUES ('github_sync', ${NOW - 90000}, ${NOW - 60}, 'HTTP 401', 3)`);
    await run(`INSERT INTO job_runs (job_name, last_failed_at, last_error, consecutive_failures) VALUES ('old_removed_job', ${NOW - 5}, 'gone', 1)`);
    const h = await health.getSystemHealth(NOW);
    const by = (n: string) => h.jobs.find(j => j.name === n)!;
    expect(by('retention_cleanup')).toMatchObject({ status: 'ok', lastSucceededAt: NOW - 100, consecutiveFailures: 0 });
    expect(by('github_sync')).toMatchObject({ status: 'failing', consecutiveFailures: 3, lastError: 'HTTP 401', lastFailedAt: NOW - 60 });
    expect(by('old_removed_job')).toMatchObject({ status: 'failing', label: 'old_removed_job' });
    expect(by('compliance_sync').status).toBe('not_run');
  });

  it('newest event per surface, as numbers (Postgres returns bigint as text)', async () => {
    await run(`INSERT INTO users (id, email) VALUES ('u1', 'u1@test.local') ON CONFLICT DO NOTHING`);
    await run(`INSERT INTO cowork_messages (id, user_id, session_id, message_type, occurred_at, surface) VALUES
               ('m1', 'u1', 's1', 'cowork_user_message', ${NOW - 500}, 'cowork'),
               ('m2', 'u1', 's1', 'cowork_user_message', ${NOW - 50}, 'cowork'),
               ('m3', 'u1', 's2', 'code_user_message', ${NOW - 7200}, 'code')`);
    const h = await health.getSystemHealth(NOW);
    const by = (k: string) => h.surfaces.find(s => s.key === k)!;
    expect(by('cowork').lastEventAt).toBe(NOW - 50);
    expect(by('code').lastEventAt).toBe(NOW - 7200);
    expect(by('code_metrics').lastEventAt).toBeNull();
  });

  it('Chat appears once a Compliance key is set', async () => {
    config.complianceAccessKey = 'sk-ant-api01-test';
    const h = await health.getSystemHealth(NOW);
    expect(h.surfaces.find(s => s.key === 'chat')).toMatchObject({ lastEventAt: null });
  });

  it('counts only ingest failures, over 24 hours and 7 days', async () => {
    await run(`INSERT INTO error_events (occurred_at, severity, source, message) VALUES
               (${NOW - 3600}, 'error', 'otel-ingest', 'insert failed'),
               (${NOW - 3 * 86400}, 'error', 'otel-ingest-record', 'no email'),
               (${NOW - 10 * 86400}, 'error', 'otel-ingest', 'too old'),
               (${NOW - 60}, 'error', 'scheduler:github_sync', 'not ingest')`);
    const h = await health.getSystemHealth(NOW);
    expect(h.ingestFailures).toEqual({ last24h: 1, last7d: 2, lastAt: NOW - 3600, lastMessage: 'insert failed' });
  });

  it('integrations: configured keys only; each follows its jobs, untracked where no job reports a rejection', async () => {
    config.complianceAccessKey = 'sk-ant-api01-test';
    config.githubToken = 'ghp_test';
    config.anthropicAiApiKey = 'sk-ant-test';
    config.smtpHost = 'smtp.test.local';
    await run(`INSERT INTO job_runs (job_name, last_failed_at, last_error, consecutive_failures)
               VALUES ('compliance_sync', ${NOW - 30}, 'Compliance sync errors: HTTP 401', 1)`);
    await run(`INSERT INTO job_runs (job_name, last_succeeded_at, consecutive_failures) VALUES
               ('pulse_classifier', ${NOW - 300}, 0), ('code_classifier', ${NOW - 100}, 0)`);
    const h = await health.getSystemHealth(NOW);
    expect(h.integrations).toEqual([
      { key: 'anthropicAiApiKey', label: 'Anthropic API (AI features)', status: 'ok', lastSucceededAt: NOW - 100, lastFailedAt: null, lastError: null },
      { key: 'complianceAccessKey', label: 'Compliance API', status: 'failing', lastSucceededAt: null, lastFailedAt: NOW - 30, lastError: 'Compliance sync errors: HTTP 401' },
      { key: 'githubToken', label: 'GitHub', status: 'not_run', lastSucceededAt: null, lastFailedAt: null, lastError: null },
      { key: 'smtpHost', label: 'Email (SMTP)', status: 'untracked', lastSucceededAt: null, lastFailedAt: null, lastError: null },
    ]);
  });

  it('a shared key reads failing when either of its jobs is failing', async () => {
    config.anthropicAiApiKey = 'sk-ant-test';
    await run(`INSERT INTO job_runs (job_name, last_succeeded_at, last_failed_at, last_error, consecutive_failures) VALUES
               ('pulse_classifier', ${NOW - 300}, null, null, 0),
               ('code_classifier', ${NOW - 9000}, ${NOW - 60}, '401 authentication_error', 2)`);
    const h = await health.getSystemHealth(NOW);
    expect(h.integrations[0]).toMatchObject({ status: 'failing', lastFailedAt: NOW - 60, lastError: '401 authentication_error' });
  });

  it('a stored key the server cannot decrypt shows as failing, not as missing', async () => {
    unreadable.push('githubToken');
    const h = await health.getSystemHealth(NOW);
    expect(h.integrations).toEqual([
      expect.objectContaining({ key: 'githubToken', status: 'failing', lastError: expect.stringContaining('cannot be decrypted') }),
    ]);
  });
});
