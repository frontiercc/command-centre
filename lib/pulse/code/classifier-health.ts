// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Classifier-health data layer — read-only aggregates over
 * code_session_classifications (+ queue depth from
 * getClassifierQueueDepth). No new tables, no writes.
 *
 * Consumed by the Classifier Health admin tab + the classifier
 * API route.
 */
import { desc, eq, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue } from '@/lib/config';
import { getClassifierQueueDepth } from '@/lib/pulse/code/classifier';

export async function getClassifierHealth(nowS?: number) {
  const client = await getTypedClient();
  const csc = schema.codeSessionClassifications;
  const rows = await client.select({
    classified: sql<number | string | null>`SUM(CASE WHEN ${csc.status} = 'classified' THEN 1 ELSE 0 END)`,
    failed:     sql<number | string | null>`SUM(CASE WHEN ${csc.status} = 'failed' THEN 1 ELSE 0 END)`,
  }).from(csc);
  const c = rows[0];
  return {
    enabled: (await getConfigValue('codeClassifierEnabled')) !== 'false',
    model: (await getConfigValue('codeClassifierModel')) || 'claude-haiku-4-5-20251001',
    queue: await getClassifierQueueDepth(nowS),
    classified: Number(c?.classified ?? 0),
    failed: Number(c?.failed ?? 0),
    lastRunAt: (await getConfigValue('codeClassifierLastRun')) || null,
  };
}

export async function getTierDistribution() {
  const client = await getTypedClient();
  const csc = schema.codeSessionClassifications;
  const countTier = async (t: number) => {
    const r = await client.select({ c: sql<number | string>`COUNT(*)` }).from(csc)
      .where(sql`${csc.status} = 'classified' AND ${csc.tier} = ${t}`);
    return Number(r[0]?.c ?? 0);
  };
  return { tier1: await countTier(1), tier2: await countTier(2), tier3: await countTier(3) };
}

export async function getConfidenceHistogram(): Promise<number[]> {
  const client = await getTypedClient();
  const csc = schema.codeSessionClassifications;
  const rows = await client.select({ confidence: csc.confidence }).from(csc).where(eq(csc.status, 'classified'));
  const buckets = new Array(11).fill(0);
  for (const r of rows) {
    const v = Number(r.confidence);
    const idx = v >= 1 ? 10 : Math.max(0, Math.min(9, Math.floor(v * 10)));
    buckets[idx]++;
  }
  return buckets;
}

export async function getCurrentFailures(limit = 50) {
  const client = await getTypedClient();
  const csc = schema.codeSessionClassifications;
  return client.select({
    session_id: csc.session_id, user_id: csc.user_id,
    classifier_model: csc.classifier_model, error: csc.error, classified_at: csc.classified_at,
  }).from(csc).where(eq(csc.status, 'failed')).orderBy(desc(csc.classified_at)).limit(limit);
}
