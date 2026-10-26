// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Developer Pulse — data health.
 *
 * A deterministic self-check over the last 30 days: which models can't be
 * priced, which are priced only via the Bedrock/Vertex normalisation
 * fallback (an estimate, not exact provider cost), how much OTel telemetry
 * arrived with no resolvable identity, and whether the ingestion/aggregation
 * pipeline is silently falling behind. No classifier involved — same
 * measured-not-judged stance as the rest of Developer Pulse.
 *
 * code_otel_metrics has no email column (see lib/otel/code-metrics-receiver.ts —
 * identity is resolved to a `users.id` or left null; the raw email is never
 * persisted on the row), so `unattributedOtel.distinctEmails` is always 0.
 *
 * Async Drizzle on Postgres, following the blessed query pattern — read-only,
 * no writes. COUNT()/MAX()
 * aggregates are STRINGS on Postgres (bigint) — Number()-coerced at every
 * read site (Policy B).
 */
import { and, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue } from '@/lib/config';
import { getCodeModelRates, isEstimatedPricing } from '@/lib/pulse/code/rates';

const THIRTY_DAYS_S = 30 * 24 * 60 * 60;

export interface CodeHealth {
  unpricedModels: Array<{ model: string; sessions: number; totalTokens: number }>;
  estimatedModels: Array<{ model: string; sessions: number }>;
  unattributedOtel: { rows: number; distinctEmails: number };
  orphanSessions: number;
  malformedModelsJson: number;
  aggregatorLastRun: string | null;
  lastOtelIngest: number | null;
  lastMetaIngest: number | null;
}

interface ModelUsage {
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
}

export async function getCodePulseHealth(): Promise<CodeHealth> {
  const client = await getTypedClient();
  const now = Math.floor(Date.now() / 1000);
  const since = now - THIRTY_DAYS_S;
  const rates = await getCodeModelRates();

  const css = schema.codeSessionStats;
  const cam = schema.codeAssistantMeta;
  const com = schema.codeOtelMetrics;

  // ─── Pricing coverage: walk 30d models_json, classify each distinct model ──
  const statsRows = await client
    .select({ session_id: css.session_id, models_json: css.models_json })
    .from(css)
    .where(gte(css.last_at, since));

  let malformedModelsJson = 0;
  const perModel = new Map<string, { sessions: Set<string>; totalTokens: number }>();

  for (const row of statsRows) {
    if (!row.models_json) continue;
    let parsed: Record<string, ModelUsage>;
    try {
      parsed = JSON.parse(row.models_json);
    } catch {
      malformedModelsJson++;
      continue;
    }
    for (const [model, usage] of Object.entries(parsed)) {
      let entry = perModel.get(model);
      if (!entry) {
        entry = { sessions: new Set(), totalTokens: 0 };
        perModel.set(model, entry);
      }
      entry.sessions.add(row.session_id);
      entry.totalTokens += (usage.input ?? 0) + (usage.output ?? 0)
        + (usage.cache_creation ?? 0) + (usage.cache_read ?? 0);
    }
  }

  const unpricedModels: CodeHealth['unpricedModels'] = [];
  const estimatedModels: CodeHealth['estimatedModels'] = [];

  for (const [model, entry] of perModel.entries()) {
    if (rates[model] !== undefined) continue; // fully priced — not unpriced, not estimated

    if (isEstimatedPricing(model, rates)) {
      estimatedModels.push({ model, sessions: entry.sessions.size });
    } else {
      unpricedModels.push({ model, sessions: entry.sessions.size, totalTokens: entry.totalTokens });
    }
  }

  // ─── Identity: unattributed OTel rows, last 30d ────────────────────────────
  const unattributedRows = await client
    .select({ c: sql<number | string>`COUNT(*)` })
    .from(com)
    .where(and(isNull(com.user_id), gte(com.occurred_at, since)));

  // code_otel_metrics has no email column — the receiver resolves identity to
  // users.id or drops it; the raw email attribute is never persisted. Always 0.
  const unattributedOtel = { rows: Number(unattributedRows[0]?.c ?? 0), distinctEmails: 0 };

  // ─── Timestamps ─────────────────────────────────────────────────────────────
  const aggregatorLastRunRaw = await getConfigValue('codeAggregatorLastRun');
  const aggregatorLastRun = aggregatorLastRunRaw ? aggregatorLastRunRaw : null;

  // ─── Pipeline: orphan sessions — meta exists, no rollup ever ran ───────────
  // Exclude rows ingested strictly after the aggregator's last run — those
  // simply haven't had a chance to roll up yet (arrived mid-cycle or since),
  // which is normal pipeline lag, not an orphan. When the aggregator has
  // never run, there's no cutoff to apply and all matching rows count, same
  // as before this fix.
  const aggregatorLastRunTs = aggregatorLastRun
    ? Math.floor(new Date(aggregatorLastRun).getTime() / 1000)
    : null;
  const orphanConditions = [gte(cam.ingested_at, since), isNull(css.session_id)];
  if (aggregatorLastRunTs !== null) {
    orphanConditions.push(lte(cam.ingested_at, aggregatorLastRunTs));
  }
  const orphanRows = await client
    .select({ c: sql<number | string>`COUNT(DISTINCT ${cam.session_id})` })
    .from(cam)
    .leftJoin(css, eq(css.session_id, cam.session_id))
    .where(and(...orphanConditions));
  const orphanSessions = Number(orphanRows[0]?.c ?? 0);

  const lastOtelRows = await client
    .select({ m: sql<number | string | null>`MAX(${com.occurred_at})` })
    .from(com);
  const lastOtelIngest = lastOtelRows[0]?.m != null ? Number(lastOtelRows[0].m) : null;

  const lastMetaRows = await client
    .select({ m: sql<number | string | null>`MAX(${cam.ingested_at})` })
    .from(cam);
  const lastMetaIngest = lastMetaRows[0]?.m != null ? Number(lastMetaRows[0].m) : null;

  return {
    unpricedModels,
    estimatedModels,
    unattributedOtel,
    orphanSessions,
    malformedModelsJson,
    aggregatorLastRun,
    lastOtelIngest,
    lastMetaIngest,
  };
}
