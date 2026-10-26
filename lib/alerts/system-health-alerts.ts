// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * System-health alerts — the three
 * fixed rules that need no calibration, read from job_runs:
 *
 *   1. key rejected   — a job that calls an external API failed with a
 *                       401/403-shaped error on its last run;
 *   2. job failing    — two consecutive failures (one for a job that runs
 *                       daily or less often, see JOB_CATALOG.infrequent);
 *   3. retention stale — retention has not succeeded in 26 hours although it
 *                       is not failing, i.e. it is not running at all.
 *
 * When COMBINE_AT or more jobs are failing at once — usually one shared cause
 * such as the database or network — rule 2 raises ONE combined alert instead
 * of one per job. Rejected keys always stay separate: each needs its own fix.
 *
 * Severity high, so the hourly Slack sweep (lib/alerts/slack-sweep.ts) carries
 * them with no new delivery code. A job raises at most one of rules 1–2 (the
 * more specific wins). OFF unless systemHealthAlertsEnabled
 * is 'true' (System health on /admin/system shows everything either way), and
 * each problem is raised ONCE per failure: again only after the job has
 * succeeded and then failed again, not every 24 hours while it keeps failing.
 * Alert text carries job and integration names and error messages only — no
 * user identity, no payload content.
 *
 * Telemetry silence (set from a week of
 * recorded data): see lib/alerts/telemetry-silence.ts. Raised once per silence
 * (since the surface's last received event). The ingest-failure-rate rule
 * was dropped: System health already counts ingest failures.
 */
import { v4 as uuidv4 } from 'uuid';
import { and, eq, gte, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { insertAlert } from '@/lib/db/queries';
import { JOB_CATALOG, jobLabel } from '@/lib/health/job-catalog';
import { planSilenceAlerts, silenceSettingsFrom, type SilenceSurface } from '@/lib/alerts/telemetry-silence';

export const SYSTEM_HEALTH_ALERT_TYPE = 'system_health';
const DAY = 24 * 3600;
export const RETENTION_STALE_SECS = 26 * 3600;
/** This many failing jobs or more are raised as one combined alert. */
export const COMBINE_AT = 4;

/** Jobs whose failure can mean a rejected key, and the integration named. */
export const KEY_JOBS: Record<string, string> = {
  compliance_sync: 'Compliance API',
  analytics_ingest: 'Analytics API',
  github_sync: 'GitHub',
  pulse_classifier: 'Anthropic API',
  code_classifier: 'Anthropic API',
};

/** Pure: does this error text look like a rejected credential? */
export function looksLikeRejectedKey(error: string | null): boolean {
  if (!error) return false;
  return /\b(401|403)\b|authentication_error|permission_error|invalid x-api-key|bad credentials/i.test(error);
}

export interface JobRunRow {
  job_name: string;
  last_succeeded_at: number | null;
  last_failed_at: number | null;
  last_error: string | null;
  consecutive_failures: number;
}

export interface PlannedAlert {
  rule: 'key_rejected' | 'job_failing' | 'jobs_failing' | 'retention_stale' | 'secret_unreadable' | 'telemetry_silence';
  subject: string;
  title: string;
  explanation: string;
  /** Start of this failure: an alert raised at or after it is the same problem. */
  since?: number;
}

/** Pure: which alerts the current job_runs state calls for (before dedup). */
export function planSystemHealthAlerts(rows: JobRunRow[], nowS: number): PlannedAlert[] {
  const out: PlannedAlert[] = [];
  const failingJobs: { label: string; error: string; since: number }[] = [];
  for (const r of rows) {
    const failures = Number(r.consecutive_failures ?? 0);
    if (failures <= 0) continue;
    const label = jobLabel(r.job_name);
    const error = (r.last_error ?? 'no error text recorded').slice(0, 500);
    const integration = KEY_JOBS[r.job_name];
    if (integration && looksLikeRejectedKey(r.last_error)) {
      out.push({
        rule: 'key_rejected',
        subject: r.job_name,
        since: r.last_succeeded_at ?? 0,
        title: `${integration} key rejected`,
        explanation: `${label} failed because the ${integration} rejected its credentials: ${error}. Check the key on /admin/security and use its Test button.`,
      });
      continue;
    }
    const infrequent = JOB_CATALOG.find(j => j.name === r.job_name)?.infrequent === true;
    if (failures >= (infrequent ? 1 : 2)) {
      const runs = failures === 1 ? 'its last run' : `its last ${failures} runs`;
      failingJobs.push({ label, error, since: r.last_succeeded_at ?? 0 });
      out.push({
        rule: 'job_failing',
        subject: r.job_name,
        since: r.last_succeeded_at ?? 0,
        title: `Scheduled job failing: ${label}`,
        explanation: `${label} failed ${runs}. Latest error: ${error}. See System health on /admin/system.`,
      });
    }
  }

  if (failingJobs.length >= COMBINE_AT) {
    const kept = out.filter(p => p.rule !== 'job_failing');
    out.length = 0;
    out.push(...kept, {
      rule: 'jobs_failing',
      subject: 'many',
      since: Math.max(...failingJobs.map(j => j.since)),
      title: `${failingJobs.length} scheduled jobs failing`,
      explanation: `${failingJobs.length} scheduled jobs are failing at once, which usually means one shared cause such as the database or the network: ${failingJobs.map(j => j.label).join(', ')}. First error (${failingJobs[0].label}): ${failingJobs[0].error}. See System health on /admin/system.`,
    });
  }

  const retention = rows.find(r => r.job_name === 'retention_cleanup');
  if (retention && Number(retention.consecutive_failures ?? 0) === 0) {
    const last = retention.last_succeeded_at === null ? null : Number(retention.last_succeeded_at);
    if (last !== null && nowS - last > RETENTION_STALE_SECS) {
      const hours = Math.floor((nowS - last) / 3600);
      out.push({
        rule: 'retention_stale',
        subject: 'retention_cleanup',
        since: last,
        title: 'Retention has not run in over a day',
        explanation: `Retention cleanup last succeeded ${hours} hours ago and has not failed since, so it is not running. Old content is not being removed on schedule. Check that the scheduler is running (System health on /admin/system).`,
      });
    }
  }
  return out;
}

/**
 * When the hub last RECEIVED each OTel surface (ingested_at, not the client's
 * occurred_at: a late batch with old timestamps still proves delivery works).
 * Chat is a pull job, covered by the job rules.
 */
async function readSilenceSurfaces(): Promise<SilenceSurface[]> {
  const client = await getTypedClient();
  const cm = schema.coworkMessages;
  const com = schema.codeOtelMetrics;
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const last = async (surface: 'cowork' | 'code') => {
    const rows = await client.select({ v: sql<number | string | null>`MAX(${cm.ingested_at})` }).from(cm).where(eq(cm.surface, surface));
    return num(rows[0]?.v);
  };
  const metrics = await client.select({ v: sql<number | string | null>`MAX(${com.ingested_at})` }).from(com);
  return [
    { key: 'cowork', label: 'Cowork', lastReceivedAt: await last('cowork') },
    { key: 'code', label: 'Claude Code', lastReceivedAt: await last('code') },
    { key: 'code_metrics', label: 'Claude Code metrics', lastReceivedAt: num(metrics[0]?.v) },
  ];
}

async function alreadyRaised(rule: string, subject: string, sinceS: number): Promise<boolean> {
  const client = await getTypedClient();
  const a = schema.alerts;
  // Exact field reads: raw_evidence is jsonb, whose text form
  // reorders keys and adds spaces, so a LIKE over it would never match.
  const match = sql`${a.raw_evidence}->>'rule' = ${rule} AND ${a.raw_evidence}->>'subject' = ${subject}`;
  const rows = await client
    .select({ one: sql<number>`1` })
    .from(a)
    .where(and(eq(a.alert_type, SYSTEM_HEALTH_ALERT_TYPE), match, gte(a.generated_at, sinceS)))
    .limit(1);
  return rows.length > 0;
}

/** Scheduler entry point. Returns the number of alerts raised. */
export async function runSystemHealthAlerts(nowS: number = Math.floor(Date.now() / 1000)): Promise<number> {
  const { getConfigValue } = await import('@/lib/config');
  if ((await getConfigValue('systemHealthAlertsEnabled')) !== 'true') return 0;
  const client = await getTypedClient();
  const j = schema.jobRuns;
  const rows = (await client.select().from(j)).map(r => ({
    job_name: r.job_name,
    last_succeeded_at: r.last_succeeded_at === null ? null : Number(r.last_succeeded_at),
    last_failed_at: r.last_failed_at === null ? null : Number(r.last_failed_at),
    last_error: r.last_error ?? null,
    consecutive_failures: Number(r.consecutive_failures ?? 0),
  }));
  const planned = planSystemHealthAlerts(rows, nowS);
  // A stored key this server cannot decrypt.
  const { getUnreadableSecretKeys } = await import('@/lib/config');
  for (const k of await getUnreadableSecretKeys()) {
    planned.push({
      rule: 'secret_unreadable',
      subject: k,
      title: `Stored ${k} cannot be decrypted`,
      explanation: `The stored value of ${k} cannot be decrypted with this server's CCC_ENCRYPTION_KEY, so that integration is not working. Re-enter it on the admin page, or restore the key it was saved with.`,
    });
  }
  const settings = silenceSettingsFrom({
    hours: await getConfigValue('telemetrySilenceHours'),
    timeZone: await getConfigValue('telemetrySilenceTimezone'),
    workHours: await getConfigValue('telemetrySilenceWorkHours'),
  });
  planned.push(...planSilenceAlerts(await readSilenceSurfaces(), nowS, settings));
  let raised = 0;
  for (const p of planned) {
    // Once per failure (since the job last succeeded); an unreadable key, which
    // has no success to reset it, at most once a day.
    if (await alreadyRaised(p.rule, p.subject, p.since ?? nowS - DAY)) continue;
    await insertAlert({
      id: uuidv4(),
      user_id: null,
      alert_type: SYSTEM_HEALTH_ALERT_TYPE,
      severity: 'high',
      title: p.title,
      explanation: p.explanation,
      raw_evidence: JSON.stringify({ rule: p.rule, subject: p.subject, source: 'job_runs' }),
    });
    raised++;
  }
  return raised;
}

/**
 * Hourly cadence, read from this job's own job_runs row — no config key.
 * Returns false when not yet due (the scheduler records nothing then).
 */
export async function runSystemHealthAlertsJob(nowS: number = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const client = await getTypedClient();
  const j = schema.jobRuns;
  const own = await client.select({ at: j.last_succeeded_at }).from(j).where(eq(j.job_name, 'system_health_alerts')).limit(1);
  const last = own[0]?.at === null || own[0]?.at === undefined ? null : Number(own[0].at);
  if (last !== null && nowS - last < 3600) return false;
  await runSystemHealthAlerts(nowS);
  return true;
}
