// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { NextRequest, NextResponse } from 'next/server';
import { logError } from '@/lib/api/errors';
import { BodyTooLargeError, INGEST_BODY_LIMIT, INGEST_LOG_OVER, readJsonLimited } from '@/lib/api/body';
import { processOtlpLogs } from '@/lib/otel/cowork-receiver';
import { processCodeOtlpLogs } from '@/lib/otel/code-receiver';
import { processCodeOtlpMetrics } from '@/lib/otel/code-metrics-receiver';
import { authenticateIngest } from '@/lib/auth/ingest-auth';
import { isRateLimited } from '@/lib/auth/rate-limit';
import { recordIngestFailure } from '@/lib/otel/ingest-failure';
import { noteFirstTelemetry } from '@/lib/setup/first-telemetry';

export const dynamic = 'force-dynamic';

type ResourceBlock = Array<{ resource?: { attributes?: Array<{ key: string; value?: { stringValue?: string } }> } }>;

function firstResourceAttrs(payload: Record<string, unknown>): Array<{ key: string; value?: { stringValue?: string } }> {
  const logs = payload.resourceLogs as ResourceBlock | undefined;
  const metrics = payload.resourceMetrics as ResourceBlock | undefined;
  return (logs?.[0] ?? metrics?.[0])?.resource?.attributes ?? [];
}

function getOrgId(payload: Record<string, unknown>): string {
  return firstResourceAttrs(payload).find(a => a.key === 'organization.id')?.value?.stringValue ?? 'unknown';
}

function getServiceName(payload: Record<string, unknown>): string {
  return firstResourceAttrs(payload).find(a => a.key === 'service.name')?.value?.stringValue ?? '';
}

/** service.name of ONE resource entry (resourceLogs[i] / resourceMetrics[i]). */
function serviceNameOf(entry: ResourceBlock[number]): string {
  return entry?.resource?.attributes?.find(a => a.key === 'service.name')?.value?.stringValue ?? '';
}

/** The Claude Code family: the terminal CLI reports 'claude-code', the Desktop
 *  app 'claude-code-desktop' (confirmed from live capture), and other
 *  entrypoints may use further 'claude-code-*' suffixes. */
function isCodeService(name: string): boolean {
  return name === 'claude-code' || name.startsWith('claude-code-');
}

export async function POST(request: NextRequest) {
  const auth = await authenticateIngest(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: auth.httpStatus || 401 });
  }

  // A non-collector caller's rate-limit key needs nothing from the body, so it is
  // checked BEFORE the body is read. The collector's key is its organisation id,
  // which lives inside the body, so that check stays after parsing.
  if (!auth.isCollector && isRateLimited(`ingest:otel:agent:${auth.agentId}`, 600, 60000)) {
    return NextResponse.json({ error: 'Rate limited' }, { status: 429 });
  }

  try {
    // Size-capped read: 50 MB, well above the worst
    // realistic batch; large requests are logged to learn the real distribution.
    const { value: payload, bytes } = await readJsonLimited(request, INGEST_BODY_LIMIT);
    if (bytes > INGEST_LOG_OVER) {
      console.warn(`[OTel Ingest] large request: ${bytes} bytes (collector=${auth.isCollector ?? false})`);
    }

    // Logs and metrics only. Traces are not accepted: the collector forwards
    // none, and a span carries tool inputs and file paths, which are never stored.
    if (!payload.resourceLogs && !payload.resourceMetrics) {
      return NextResponse.json(
        { error: 'Missing resourceLogs or resourceMetrics' },
        { status: 400 }
      );
    }

    if (auth.isCollector && isRateLimited(`ingest:otel:org:${getOrgId(payload)}`, 600, 60000)) {
      return NextResponse.json({ error: 'Rate limited' }, { status: 429 });
    }

    // Route by service.name PER RESOURCE, not per request. The collector's
    // batch processor merges everything it received in a 2s window into ONE
    // export request, so a request routinely carries a Cowork resource
    // (service.name='cowork') AND a Claude Code resource ('claude-code',
    // 'claude-code-desktop', any 'claude-code-*') side by side. Never route
    // a whole request by its FIRST resource's service.name: each receiver
    // skips resources that are not its own, so the other surface's events
    // would be silently dropped (no error, no log). Instead, split the
    // resources by family, hand each group to its receiver, merge the
    // results. A single-surface request makes exactly one call and returns
    // that receiver's result verbatim.
    if (payload.resourceLogs) {
      const entries = payload.resourceLogs as ResourceBlock;
      const cowork = entries.filter(e => serviceNameOf(e) === 'cowork');
      const code = entries.filter(e => isCodeService(serviceNameOf(e)));
      const unrecognised = entries
        .filter(e => serviceNameOf(e) !== 'cowork' && !isCodeService(serviceNameOf(e)))
        .map(e => serviceNameOf(e) || '(empty)');

      const coworkResult = cowork.length ? await processOtlpLogs({ ...payload, resourceLogs: cowork }) : null;
      const codeResult = code.length ? await processCodeOtlpLogs({ ...payload, resourceLogs: code }) : null;
      // The dashboard's "Get started" panel ticks off each product on its first
      // real telemetry (lib/setup/first-telemetry.ts; never throws).
      if (coworkResult) await noteFirstTelemetry('cowork');
      if (codeResult) await noteFirstTelemetry('code');
      const unrecognisedErrors = unrecognised.map(n => `Unrecognised service.name: ${n}`);

      if (coworkResult && !codeResult && unrecognisedErrors.length === 0) return NextResponse.json(coworkResult);
      if (codeResult && !coworkResult && unrecognisedErrors.length === 0) return NextResponse.json(codeResult);
      if (!coworkResult && !codeResult) {
        return NextResponse.json({ processed: 0, skipped: 0, errors: unrecognisedErrors });
      }
      // Mixed request: one merged body carrying both receivers' counts.
      return NextResponse.json({
        logsInserted: coworkResult?.logsInserted ?? 0,
        processed: codeResult?.processed ?? 0,
        skipped: (coworkResult?.skipped ?? 0) + (codeResult?.skipped ?? 0),
        usersCreated: coworkResult?.usersCreated ?? 0,
        sessionsCreated: coworkResult?.sessionsCreated ?? 0,
        alertsFired: coworkResult?.alertsFired ?? 0,
        errors: [...(coworkResult?.errors ?? []), ...(codeResult?.errors ?? []), ...unrecognisedErrors],
      });
    }

    // OTel METRICS stream (Developer Pulse productivity signals). Developer Pulse only —
    // cowork metrics are not consumed. Same per-resource rule: only
    // the claude-code* resources are handed on, whatever position they hold.
    if (payload.resourceMetrics) {
      const entries = payload.resourceMetrics as ResourceBlock;
      const code = entries.filter(e => isCodeService(serviceNameOf(e)));
      if (code.length) {
        const result = await processCodeOtlpMetrics({ ...payload, resourceMetrics: code });
        await noteFirstTelemetry('code');
        return NextResponse.json(result);
      }
      const serviceName = getServiceName(payload);
      return NextResponse.json({ processed: 0, skipped: 0, errors: [`Metrics ignored for service.name: ${serviceName || '(empty)'}`] });
    }

    return NextResponse.json({ error: 'Missing resourceLogs or resourceMetrics' }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError('OTel Ingest', err);
    // A body that is not JSON can never succeed: 400 (the collector drops it).
    // Anything else reaching here is request-level — typically the database
    // being unreachable — and answers 503, which the collector RETRIES (it
    // treats 500 as permanent and deletes the batch). Retrying is safe because
    // every record claims a stable key first (lib/otel/event-key.ts), so a
    // re-delivered record is skipped, never stored twice. Per-record and
    // per-resource failures never reach here: they are contained with a 200.
    // Too large: 413, which the collector treats as permanent. Retrying the same
    // body could never succeed, so a retryable 503 would loop forever.
    const status = err instanceof BodyTooLargeError ? 413 : err instanceof SyntaxError ? 400 : 503;
    await recordIngestFailure('otel-ingest', message, { status, collector: auth.isCollector ?? false });
    return NextResponse.json(
      // Fixed text only: the detail is in the server log and error_events.
      { eventsInserted: 0, errors: [status === 413 ? 'Request body too large' : status === 400 ? 'Request body is not valid JSON' : 'Temporary failure, retry'] },
      { status }
    );
  }
}
