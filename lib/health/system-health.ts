// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * System health panel data.
 *
 * Reads only what is already recorded: job_runs, error_events rows
 * from the ingest route (sources 'otel-ingest%'), the newest event per
 * surface, and which integration keys are configured.
 *
 * Rules:
 *   - a job with no job_runs row is 'not_run' — never shown as healthy;
 *   - an integration with no job that reports a rejected key as a failure
 *     (Admin API, SMTP) is 'untracked', never 'ok';
 *   - no prompt text, attribute values or user identity — names, counts,
 *     timestamps and error messages only.
 */
import { and, desc, eq, gte, like, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue, getUnreadableSecretKeys } from '@/lib/config';
import { JOB_CATALOG } from '@/lib/health/job-catalog';

export type JobStatus = 'ok' | 'failing' | 'not_run';

export interface JobHealth {
  name: string;
  label: string;
  status: JobStatus;
  lastSucceededAt: number | null;
  lastFailedAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export interface SurfaceHealth {
  key: 'cowork' | 'code' | 'code_metrics' | 'chat';
  label: string;
  lastEventAt: number | null;
}

export interface IngestFailureHealth {
  last24h: number;
  last7d: number;
  lastAt: number | null;
  lastMessage: string | null;
}

export type IntegrationStatus = 'ok' | 'failing' | 'not_run' | 'untracked';

export interface IntegrationHealth {
  key: string;
  label: string;
  status: IntegrationStatus;
  lastSucceededAt: number | null;
  lastFailedAt: number | null;
  lastError: string | null;
}

export interface SystemHealth {
  generatedAt: number;
  jobs: JobHealth[];
  surfaces: SurfaceHealth[];
  ingestFailures: IngestFailureHealth;
  integrations: IntegrationHealth[];
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * Integrations shown on the panel. `jobs` lists the scheduled jobs whose failure
 * reports a rejected key (the classifiers, analytics ingest and
 * GitHub sync do so); empty means the row reads "not tracked yet".
 */
const INTEGRATIONS: { key: 'complianceAccessKey' | 'anthropicAiApiKey' | 'anthropicAnalyticsApiKey' | 'anthropicAdminApiKey' | 'githubToken' | 'smtpHost'; label: string; jobs: string[] }[] = [
  { key: 'anthropicAiApiKey', label: 'Anthropic API (AI features)', jobs: ['pulse_classifier', 'code_classifier'] },
  { key: 'complianceAccessKey', label: 'Compliance API', jobs: ['compliance_sync'] },
  { key: 'anthropicAnalyticsApiKey', label: 'Analytics API', jobs: ['analytics_ingest'] },
  { key: 'anthropicAdminApiKey', label: 'Admin API', jobs: [] },
  { key: 'githubToken', label: 'GitHub', jobs: ['github_sync'] },
  { key: 'smtpHost', label: 'Email (SMTP)', jobs: [] },
];

export async function getSystemHealth(nowS: number = Math.floor(Date.now() / 1000)): Promise<SystemHealth> {
  const client = await getTypedClient();

  // ── Scheduled jobs ────────────────────────────────────────────────
  const j = schema.jobRuns;
  const runRows = await client.select().from(j);
  const byName = new Map(runRows.map(r => [r.job_name, r]));
  const toJob = (name: string, label: string): JobHealth => {
    const r = byName.get(name);
    if (!r) {
      return { name, label, status: 'not_run', lastSucceededAt: null, lastFailedAt: null, lastError: null, consecutiveFailures: 0 };
    }
    const failures = Number(r.consecutive_failures ?? 0);
    const succeeded = num(r.last_succeeded_at);
    return {
      name,
      label,
      status: failures > 0 ? 'failing' : succeeded !== null ? 'ok' : 'not_run',
      lastSucceededAt: succeeded,
      lastFailedAt: num(r.last_failed_at),
      lastError: r.last_error ?? null,
      consecutiveFailures: failures,
    };
  };
  const jobs = JOB_CATALOG.map(e => toJob(e.name, e.label));
  // A recorded job the catalogue does not know (a renamed or removed job) is
  // still shown, so a failure can never be hidden by a stale list.
  for (const r of runRows) {
    if (!JOB_CATALOG.some(e => e.name === r.job_name)) jobs.push(toJob(r.job_name, r.job_name));
  }

  // ── Telemetry received ────────────────────────────────────────────
  const cm = schema.coworkMessages;
  const maxOccurred = async (surface: 'cowork' | 'code') => {
    const rows = await client
      .select({ v: sql<number | string | null>`MAX(${cm.occurred_at})` })
      .from(cm)
      .where(eq(cm.surface, surface));
    return num(rows[0]?.v);
  };
  const com = schema.codeOtelMetrics;
  const metricsRows = await client.select({ v: sql<number | string | null>`MAX(${com.occurred_at})` }).from(com);
  const chat = schema.chatMessages;
  const chatRows = await client.select({ v: sql<number | string | null>`MAX(${chat.ingested_at})` }).from(chat);

  const surfaces: SurfaceHealth[] = [
    { key: 'cowork', label: 'Cowork', lastEventAt: await maxOccurred('cowork') },
    { key: 'code', label: 'Claude Code', lastEventAt: await maxOccurred('code') },
    { key: 'code_metrics', label: 'Claude Code metrics', lastEventAt: num(metricsRows[0]?.v) },
  ];
  const chatLast = num(chatRows[0]?.v);
  const complianceKey = await getConfigValue('complianceAccessKey');
  if (complianceKey || chatLast !== null) {
    surfaces.push({ key: 'chat', label: 'Chat (Compliance API)', lastEventAt: chatLast });
  }

  // ── Ingest failures ───────────────────────────────────────────────
  const ee = schema.errorEvents;
  const isIngest = like(ee.source, 'otel-ingest%');
  const countSince = async (sinceS: number) => {
    const rows = await client
      .select({ n: sql<number | string>`COUNT(*)` })
      .from(ee)
      .where(and(isIngest, gte(ee.occurred_at, sinceS)));
    return Number(rows[0]?.n ?? 0);
  };
  const lastRows = await client
    .select({ at: ee.occurred_at, message: ee.message })
    .from(ee)
    .where(isIngest)
    .orderBy(desc(ee.occurred_at))
    .limit(1);
  const ingestFailures: IngestFailureHealth = {
    last24h: await countSince(nowS - 86400),
    last7d: await countSince(nowS - 7 * 86400),
    lastAt: num(lastRows[0]?.at),
    lastMessage: lastRows[0]?.message ?? null,
  };

  // ── Integrations (configured keys only) ───────────────────────────
  const integrations: IntegrationHealth[] = [];
  // A stored key that cannot be decrypted reads as '' — show it as failing
  // rather than let it drop off the list as "not configured".
  const unreadable = new Set<string>(await getUnreadableSecretKeys());
  for (const i of INTEGRATIONS) {
    if (unreadable.has(i.key)) {
      integrations.push({ key: i.key, label: i.label, status: 'failing', lastSucceededAt: null, lastFailedAt: null, lastError: "The stored key cannot be decrypted with this server's encryption key. Re-enter it, or restore the key it was saved with." });
      continue;
    }
    if (!(await getConfigValue(i.key))) continue;
    const used = jobs.filter(x => i.jobs.includes(x.name));
    if (used.length === 0) {
      integrations.push({ key: i.key, label: i.label, status: 'untracked', lastSucceededAt: null, lastFailedAt: null, lastError: null });
      continue;
    }
    // Several jobs share one key (both classifiers use the Anthropic key):
    // failing if any is failing, otherwise the most recent success.
    const failingJob = used.find(x => x.status === 'failing');
    const maxOf = (vals: (number | null)[]) => vals.reduce<number | null>((m, v) => (v !== null && (m === null || v > m) ? v : m), null);
    const lastSucceededAt = maxOf(used.map(x => x.lastSucceededAt));
    integrations.push({
      key: i.key,
      label: i.label,
      status: failingJob ? 'failing' : lastSucceededAt !== null ? 'ok' : 'not_run',
      lastSucceededAt,
      lastFailedAt: failingJob ? failingJob.lastFailedAt : maxOf(used.map(x => x.lastFailedAt)),
      lastError: failingJob ? failingJob.lastError : null,
    });
  }

  return { generatedAt: nowS, jobs, surfaces, ingestFailures, integrations };
}
