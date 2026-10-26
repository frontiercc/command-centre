// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Async Drizzle on Postgres. Follows the
// standard pattern: getTypedClient() + schema.<table>.
// COUNT/SUM aggregates are Number()-coerced (bigint comes back as
// a STRING on Postgres).
import { NextRequest, NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { getAdminSession } from '@/lib/auth/admin-auth';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue, setConfigValue } from '@/lib/config';
import { runCodeClassifierJob, getClassifierQueueDepth } from '@/lib/pulse/code/classifier';
import { drainJob } from '@/lib/pulse/drain';
import { getClassifierHealth, getTierDistribution, getConfidenceHistogram, getCurrentFailures } from '@/lib/pulse/code/classifier-health';
import { getCodeClassifierConfig, buildCodeClassifierSystemMessage, DEFAULT_CODE_CLASSIFIER_CONFIG, type CodeClassifierConfig } from '@/lib/pulse/code/tier-config';

export const dynamic = 'force-dynamic';

/** Bounded drain cap for POST run-now — see the loop below. */
const MAX_DRAIN_PASSES = 20;

/** Affected-row count from node-postgres's `.rowCount`. */
function rowsAffected(result: unknown): number {
  return (result as { rowCount?: number | null }).rowCount ?? 0;
}

export async function GET(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!['admin', 'manager'].includes(session.role ?? '')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const client = await getTypedClient();
  const pb = schema.pulseBriefings;

  const briefingsRows = await client
    .select({ c: sql<number | string>`COUNT(*)` })
    .from(pb)
    .where(and(eq(pb.scope_type, 'organisation'), eq(pb.scope_id, 'code-org')));
  const briefings = briefingsRows[0];

  const classifierConfig = await getCodeClassifierConfig();

  // Per-panel fault tolerance — a query error on one health panel must not
  // 500 the whole GET; each falls back to a safe empty/zeroed default.
  const health = await getClassifierHealth().catch(() => ({
    enabled: false,
    model: '',
    queue: { final: 0, provisional: 0, finalise: 0, total: 0 },
    classified: 0,
    failed: 0,
    lastRunAt: null as string | null,
  }));
  const tierDistribution = await getTierDistribution().catch(() => ({ tier1: 0, tier2: 0, tier3: 0 }));
  const confidenceHistogram = await getConfidenceHistogram().catch(() => new Array(11).fill(0));
  const currentFailures = await getCurrentFailures().catch(() => []);

  return NextResponse.json({
    briefings: Number(briefings?.c ?? 0),
    enabled: health.enabled,
    model: health.model,
    includePrompt: (await getConfigValue('codeClassifierIncludePrompt')) !== 'false',
    classified: health.classified,
    failed: health.failed,
    lastRun: health.lastRunAt,
    queue: health.queue,
    tierDistribution,
    confidenceHistogram,
    currentFailures,
    config: classifierConfig,
    defaults: DEFAULT_CODE_CLASSIFIER_CONFIG,
  });
}

/** Admin actions: retry-failed (clears failed rows so the next run reclassifies), run-now. */
export async function POST(request: NextRequest) {
  const session = await getAdminSession(request);
  if (!session.authenticated) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  let body: { action?: string; config?: CodeClassifierConfig };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (body.action === 'save-rubric') {
    const config = (body as { config?: CodeClassifierConfig }).config;
    if (!config?.tiers?.tier1 || !config?.tiers?.tier2 || !config?.tiers?.tier3) {
      return NextResponse.json({ error: 'config.tiers must include tier1, tier2, tier3' }, { status: 400 });
    }
    if (!Array.isArray(config.workTypes) || config.workTypes.length === 0) {
      return NextResponse.json({ error: 'config.workTypes must be a non-empty array' }, { status: 400 });
    }
    if (config.workTypes.some(w => !w?.name || !w.name.trim())) {
      return NextResponse.json({ error: 'every work type must have a non-empty name' }, { status: 400 });
    }
    if ([config.tiers.tier1, config.tiers.tier2, config.tiers.tier3].some(t => !t?.name || !t.name.trim())) {
      return NextResponse.json({ error: 'tier1, tier2, and tier3 must each have a non-empty name' }, { status: 400 });
    }
    if (typeof config.confidenceThreshold !== 'number' || config.confidenceThreshold < 0 || config.confidenceThreshold > 1) {
      return NextResponse.json({ error: 'confidenceThreshold must be 0.0–1.0' }, { status: 400 });
    }
    await setConfigValue('codeClassifierConfig', JSON.stringify(config));
    // A saved rubric applies from the moment it is saved: sessions classified
    // from now on use it, past classifications stay. Deleting every
    // classification would empty the Code Work Mix and journey grid until the
    // whole history had been redone.
    return NextResponse.json({ ok: true, promptPreview: buildCodeClassifierSystemMessage(config) });
  }

  if (body.action === 'retry-failed') {
    const client = await getTypedClient();
    const csc = schema.codeSessionClassifications;
    const result = await client.delete(csc).where(eq(csc.status, 'failed'));
    return NextResponse.json({ ok: true, cleared: rowsAffected(result) });
  }

  if (body.action === 'run-now') {
    // Bounded drain — runs the job repeatedly until the queue is empty,
    // nothing progresses, or MAX_DRAIN_PASSES is hit, so "Run now" clears
    // the visible backlog in one click instead of requiring N manual clicks.
    const result = await drainJob(runCodeClassifierJob, { maxPasses: MAX_DRAIN_PASSES });
    const remaining = (await getClassifierQueueDepth()).total;
    return NextResponse.json({ ok: true, classified: result.classified, failed: result.failed, remaining });
  }

  return NextResponse.json({ error: 'Unknown action. Use retry-failed or run-now' }, { status: 400 });
}
