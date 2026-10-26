// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Developer Pulse OTel pivot, Phase 1 — OpenTelemetry METRICS receiver.
 *
 * Claude Code exports productivity metrics (engaged time, lines of code, commits,
 * PRs, edit accept/reject) that CCC never ingested while it consumed only the
 * logs/events stream. This receiver parses OTLP `resourceMetrics` for the
 * `claude-code*` service family and writes one row per data point into
 * `code_otel_metrics`. The hourly aggregator rolls them up per scope.
 *
 * Standing decision: NO repo attribution (cwd is not in Claude Code OTel). These
 * metrics are keyed to the developer (user.email) — already in Developer Pulse scope.
 *
 * Temporality: the managed-settings rollout sets
 * OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta, so each data point is
 * an interval increment and the aggregator SUMs them.
 *
 * Async Drizzle on Postgres. Non-transactional — each insert-or-ignore is an
 * independent, idempotent write, so no savepointEach is needed. The receiver
 * acquires its own client via getTypedClient().
 */
import { eq } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { lookupOtelUserId } from '@/lib/otel/resolve-user';

/** OTLP key-value attribute as it arrives in JSON payloads. */
interface OtlpAttr {
  key: string;
  value: {
    stringValue?: string;
    intValue?: string | number;
    doubleValue?: number;
    boolValue?: boolean;
  };
}

interface OtlpDataPoint {
  attributes?: OtlpAttr[];
  asInt?: string | number;
  asDouble?: number;
  timeUnixNano?: string;
}

interface OtlpMetric {
  name?: string;
  sum?: { dataPoints?: OtlpDataPoint[] };
  gauge?: { dataPoints?: OtlpDataPoint[] };
}

interface OtlpMetricsPayload {
  resourceMetrics?: Array<{
    resource?: { attributes?: OtlpAttr[] };
    scopeMetrics?: Array<{ metrics?: OtlpMetric[] }>;
  }>;
}

export interface ProcessResult {
  processed: number;
  skipped: number;
  errors: string[];
}

/**
 * Phase 1 metric whitelist. `typeAttr` is the data-point attribute whose value
 * we persist into `code_otel_metrics.type` (null when the metric has no sub-type).
 */
const CAPTURED_METRICS: Record<string, { typeAttr: string | null }> = {
  'claude_code.active_time.total': { typeAttr: 'type' },      // user | cli
  'claude_code.lines_of_code.count': { typeAttr: 'type' },    // added | removed
  'claude_code.commit.count': { typeAttr: null },
  'claude_code.pull_request.count': { typeAttr: null },
  'claude_code.code_edit_tool.decision': { typeAttr: 'decision' }, // accept | reject
};

function getAttr(attributes: OtlpAttr[], key: string): string | undefined {
  const attr = attributes.find(a => a.key === key);
  if (!attr) return undefined;
  const v = attr.value;
  return v.stringValue ?? v.intValue?.toString() ?? undefined;
}

function dataPointValue(dp: OtlpDataPoint): number {
  if (dp.asDouble != null) return dp.asDouble;
  if (dp.asInt != null) return Number(dp.asInt);
  return 0;
}

function dataPointSeconds(dp: OtlpDataPoint): number {
  if (dp.timeUnixNano) {
    const n = Number(dp.timeUnixNano);
    if (!isNaN(n) && n > 0) return Math.floor(n / 1e9);
  }
  return Math.floor(Date.now() / 1000);
}

/**
 * Process an OTLP Metrics payload (resourceMetrics) for the claude-code* family.
 * Writes captured data points into code_otel_metrics (INSERT OR IGNORE, idempotent).
 */
export async function processCodeOtlpMetrics(payload: unknown): Promise<ProcessResult> {
  const result: ProcessResult = { processed: 0, skipped: 0, errors: [] };

  const p = payload as OtlpMetricsPayload;
  if (!p?.resourceMetrics?.length) {
    result.errors.push('No resourceMetrics in payload');
    return result;
  }

  const client = await getTypedClient();
  const com = schema.codeOtelMetrics;

  // Excluded emails — same config key as the logs receiver.
  const excludedRows = await client
    .select({ value: schema.config.value })
    .from(schema.config)
    .where(eq(schema.config.key, 'otel_excluded_emails'))
    .limit(1);
  let excludedEmails: string[] = [];
  if (excludedRows[0]?.value) {
    try { excludedEmails = JSON.parse(excludedRows[0].value); } catch { /* malformed — ignore */ }
  }

  const userIdCache = new Map<string, string>();
  for (const rm of p.resourceMetrics) {
    const resAttrs = rm.resource?.attributes ?? [];

    // Only the claude-code* family (CLI + Desktop + future entrypoints). Cowork is 'cowork'.
    const serviceName = getAttr(resAttrs, 'service.name') ?? '';
    if (serviceName !== 'claude-code' && !serviceName.startsWith('claude-code-')) {
      result.skipped++;
      continue;
    }

    for (const sm of rm.scopeMetrics ?? []) {
      for (const metric of sm.metrics ?? []) {
        const name = metric.name ?? '';
        const spec = CAPTURED_METRICS[name];
        if (!spec) { result.skipped++; continue; }

        const dataPoints = metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? [];
        for (const dp of dataPoints) {
          const dpAttrs = dp.attributes ?? [];

          // Identity lives on the data-point attributes (resource carries only
          // service/os/host), mirroring the logs receiver. Resource is a fallback.
          const email = getAttr(dpAttrs, 'user.email') ?? getAttr(resAttrs, 'user.email');
          if (!email) { result.skipped++; continue; }
          if (excludedEmails.some(e => e.trim().toLowerCase() === email.toLowerCase())) {
            result.skipped++;
            continue;
          }

          // Same person the log receivers resolve to (lib/otel/resolve-user.ts).
          // The OTel user.id is an installation id, so it is used only when no
          // other person holds it — otherwise a second Claude account's metrics
          // were credited to whoever first sent from that machine. Memoised per
          // request: one lookup per person, not per data point.
          const installationId = getAttr(dpAttrs, 'user.id') ?? getAttr(resAttrs, 'user.id') ?? null;
          const cacheKey = `${email.toLowerCase()}|${installationId ?? ''}`;
          let userId = userIdCache.get(cacheKey);
          if (userId === undefined) {
            userId = await lookupOtelUserId(client, email, installationId);
            userIdCache.set(cacheKey, userId);
          }

          const sessionId = getAttr(dpAttrs, 'session.id') ?? getAttr(resAttrs, 'session.id') ?? null;
          const type = spec.typeAttr ? (getAttr(dpAttrs, spec.typeAttr) ?? null) : null;
          const model = getAttr(dpAttrs, 'model') ?? null;
          const language = getAttr(dpAttrs, 'language') ?? null;
          const value = dataPointValue(dp);
          const occurredAt = dataPointSeconds(dp);

          // Deterministic dedup id: a re-POSTed batch maps to the same key.
          const id = [name, sessionId ?? '', type ?? '', model ?? '', language ?? '', occurredAt].join('|');

          await client
            .insert(com)
            .values({
              id,
              user_id: userId,
              session_id: sessionId,
              metric_name: name,
              value,
              type,
              model,
              language,
              occurred_at: occurredAt,
            })
            .onConflictDoNothing();
          result.processed++;
        }
      }
    }
  }

  return result;
}
