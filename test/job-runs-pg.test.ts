// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// runJob records each scheduled job's outcome in job_runs (system-health spec
// part 2), on Postgres.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let cleanup: () => Promise<void>;
let sqlTag: typeof import('drizzle-orm').sql;
let jobs: typeof import('@/lib/ingestion/job-runs');

async function rows(text: string): Promise<Array<Record<string, unknown>>> {
  const r = await db.execute(sqlTag.raw(text));
  return (r.rows ?? r) as Array<Record<string, unknown>>;
}

describe('runJob (postgres)', () => {
  beforeAll(async () => {
    const { createTestDbClient } = await import('./helpers/db');
    const c = await createTestDbClient('postgres');
    db = c.client; cleanup = c.cleanup;
    sqlTag = (await import('drizzle-orm')).sql;
    jobs = await import('@/lib/ingestion/job-runs');
  }, 180_000);
  afterAll(async () => { if (cleanup) await cleanup(); });
  beforeEach(async () => { await rows(`DELETE FROM job_runs`); await rows(`DELETE FROM error_events WHERE source LIKE 'scheduler:%'`); });

  const job = async (name: string) => (await rows(`SELECT * FROM job_runs WHERE job_name = '${name}'`))[0];

  it('a job that was not due writes nothing', async () => {
    await jobs.runJob('not_due', 'Not due', async () => jobs.JOB_SKIPPED);
    expect(await job('not_due')).toBeUndefined();
  });

  it('a job switched off clears its old failures; a job not due keeps them', async () => {
    await jobs.runJob('off_job', 'Off job', async () => { throw new Error('HTTP 404'); });
    await jobs.runJob('off_job', 'Off job', async () => jobs.JOB_SKIPPED);
    expect(Number((await job('off_job')).consecutive_failures)).toBe(1);
    await jobs.runJob('off_job', 'Off job', async () => jobs.JOB_DISABLED);
    expect(await job('off_job')).toBeUndefined();
  });

  it('a successful run records success and duration', async () => {
    await jobs.runJob('ok_job', 'OK job', async () => {});
    const r = await job('ok_job');
    expect(Number(r.last_succeeded_at)).toBeGreaterThan(1_700_000_000);
    expect(Number(r.consecutive_failures)).toBe(0);
    expect(r.last_failed_at).toBeNull();
    expect(Number(r.last_duration_ms)).toBeGreaterThanOrEqual(0);
  });

  it('failures count up, keep the error, reach error_events, and never throw', async () => {
    await expect(jobs.runJob('bad_job', 'Bad job', async () => { throw new Error('bind message has 4464 parameter formats'); })).resolves.toBeUndefined();
    await jobs.runJob('bad_job', 'Bad job', async () => { throw new Error('second failure'); });
    const r = await job('bad_job');
    expect(Number(r.consecutive_failures)).toBe(2);
    expect(r.last_error).toBe('second failure');
    expect(Number(r.last_failed_at)).toBeGreaterThan(1_700_000_000);
    const ev = await rows(`SELECT message FROM error_events WHERE source = 'scheduler:bad_job' ORDER BY id`);
    expect(ev.map(e => e.message)).toEqual(['bind message has 4464 parameter formats', 'second failure']);
  });

  it('a database error records the driver\'s underlying reason, not just "Failed query"', async () => {
    // The shape Drizzle throws: its own message, with the pg error as `cause`.
    const driver = new Error('Connection terminated unexpectedly');
    const drizzle = new Error('Failed query: select "value" from "config" where "config"."key" = $1 limit $2', { cause: driver });
    await jobs.runJob('db_blip', 'DB blip', async () => { throw drizzle; });
    const r = await job('db_blip');
    expect(r.last_error).toContain('Failed query');
    expect(r.last_error).toContain('Caused by: Connection terminated unexpectedly');
  });

  it('describeError follows causes, skips repeats, and handles non-errors', () => {
    const a = new Error('top', { cause: new Error('middle', { cause: new Error('root') }) });
    expect(jobs.describeError(a)).toBe('top. Caused by: middle. Caused by: root');
    expect(jobs.describeError(new Error('same', { cause: new Error('same') }))).toBe('same');
    expect(jobs.describeError('plain string')).toBe('plain string');
  });

  it('a success after failures resets the count and keeps the last failure time', async () => {
    await jobs.runJob('flaky', 'Flaky', async () => { throw new Error('boom'); });
    await jobs.runJob('flaky', 'Flaky', async () => {});
    const r = await job('flaky');
    expect(Number(r.consecutive_failures)).toBe(0);
    expect(r.last_failed_at).not.toBeNull();
    expect(r.last_error).toBe('boom');
  });
});
