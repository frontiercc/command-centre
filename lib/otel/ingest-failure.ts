// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Durable record of an OTel ingest failure, in error_events.
 *
 * An ingest failure used to be printed to the container log and
 * nowhere else. A hub answered HTTP 500 to about 4.6% of its log
 * exports for weeks, the collector deleted every one of those batches, and the
 * only trace was a log that the next redeploy replaced. This makes each
 * failure visible in the admin error views and on error_events' own retention
 * window (retentionErrorDays).
 *
 * Context carries counts, service names and status only — NEVER payload
 * content, attribute values or user identity.
 *
 * Its own module so a receiver test that mocks a receiver's other imports
 * cannot silently remove it (same reasoning as lib/alerts/pii-alert-failure.ts).
 * Never throws: it runs inside catch blocks on the ingest path.
 */
import { insertErrorEvents } from '@/lib/db/error-queries';

export async function recordIngestFailure(
  source: string,
  message: string,
  context: Record<string, string | number | boolean | null | string[]>,
): Promise<void> {
  try {
    await insertErrorEvents([{
      severity: 'error',
      source,
      message: message.slice(0, 2000),
      context_json: JSON.stringify(context),
    }]);
  } catch (err) {
    console.error('[OTel Ingest] could not record failure:', err instanceof Error ? err.message : err);
  }
}
