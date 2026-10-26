// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Record each scheduled job's outcome.
 *
 * Every scheduler job used to be a bare try/catch that printed
 * `[Scheduler] <job> failed:` and moved on, so a job failing every night looked
 * exactly like a job working — retention came within two days of doing just
 * that, and a rejected Compliance key went unnoticed for 13 hours.
 *
 * `runJob(name, fn)`:
 *   - fn returns JOB_SKIPPED when the job was not due → nothing is written;
 *   - fn returns JOB_DISABLED when the job is switched off because it is not
 *     set up (e.g. the GitHub sync with no token) → its row is deleted, so the
 *     System health panel shows it as not run rather than keeping old failures
 *     on screen for a job that no longer runs;
 *   - otherwise a success (duration, consecutive_failures reset to 0);
 *   - a throw → a failure (error text, consecutive_failures + 1), the same
 *     console line as before, and an error_events row (source scheduler:<job>).
 * One row per job, upserted. Never throws: recording must never be the thing
 * that stops the scheduler cycle.
 */
import { eq, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { insertErrorEvents } from '@/lib/db/error-queries';

export const JOB_SKIPPED = Symbol('job-skipped');
export const JOB_DISABLED = Symbol('job-disabled');
export type JobResult = typeof JOB_SKIPPED | typeof JOB_DISABLED | void;

/** Display label for the console line, kept identical to the old messages. */
export async function runJob(name: string, label: string, fn: () => Promise<JobResult>): Promise<void> {
  const startedAt = Date.now();
  let outcome: JobResult;
  try {
    outcome = await fn();
  } catch (err) {
    const message = describeError(err);
    console.error(`[Scheduler] ${label} failed:`, message);
    await record(name, startedAt, message);
    return;
  }
  if (outcome === JOB_SKIPPED) return;
  if (outcome === JOB_DISABLED) { await clear(name); return; }
  await record(name, startedAt, null);
}

async function clear(name: string): Promise<void> {
  try {
    const client = await getTypedClient();
    await client.delete(schema.jobRuns).where(eq(schema.jobRuns.job_name, name));
  } catch (err) {
    console.error(`[Scheduler] could not clear outcome of ${name}:`, err instanceof Error ? err.message : err);
  }
}

/**
 * An error's message plus its underlying causes. A database error arrives as
 * Drizzle's "Failed query: …" with the driver's real reason (a dropped
 * connection, a timeout, a constraint) in `cause`; recording only the top line
 * left a production failure undiagnosable once the container log
 * was gone. Follows up to three levels of `cause`.
 */
export function describeError(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur !== undefined && cur !== null && depth < 4; depth++) {
    const msg = cur instanceof Error ? cur.message : String(cur);
    if (msg && !parts.includes(msg)) parts.push(msg);
    cur = cur instanceof Error ? (cur as Error & { cause?: unknown }).cause : undefined;
  }
  return parts.join('. Caused by: ');
}

async function record(name: string, startedAtMs: number, error: string | null): Promise<void> {
  try {
    const client = await getTypedClient();
    const j = schema.jobRuns;
    const nowS = Math.floor(Date.now() / 1000);
    const startedS = Math.floor(startedAtMs / 1000);
    const durationMs = Date.now() - startedAtMs;
    if (error === null) {
      await client.insert(j).values({
        job_name: name, last_started_at: startedS, last_succeeded_at: nowS,
        consecutive_failures: 0, last_duration_ms: durationMs,
      }).onConflictDoUpdate({
        target: j.job_name,
        set: { last_started_at: startedS, last_succeeded_at: nowS, consecutive_failures: 0, last_duration_ms: durationMs },
      });
    } else {
      const text = error.slice(0, 1000);
      await client.insert(j).values({
        job_name: name, last_started_at: startedS, last_failed_at: nowS, last_error: text,
        consecutive_failures: 1, last_duration_ms: durationMs,
      }).onConflictDoUpdate({
        target: j.job_name,
        set: {
          last_started_at: startedS, last_failed_at: nowS, last_error: text, last_duration_ms: durationMs,
          consecutive_failures: sql`${j.consecutive_failures} + 1`,
        },
      });
      await insertErrorEvents([{ severity: 'error', source: `scheduler:${name}`, message: text }]);
    }
  } catch (err) {
    console.error(`[Scheduler] could not record outcome of ${name}:`, err instanceof Error ? err.message : err);
  }
}
