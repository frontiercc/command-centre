// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Durable record of a PII alert that failed to write.
 *
 * History, because this reverses and then restores an earlier decision.
 * `createPiiAlertsWithDedup` was originally called fire-and-forget from the
 * OTel receivers, so a write failure was swallowed and a security alert could
 * vanish with no trace. A review fix (task 3.1c) made the call awaited inside
 * the per-record try/catch so failures surfaced in `result.errors`, guarded by
 * test/otel-pii-alert-failure-surfaces.test.ts.
 *
 * A Claude call was added inside that function (the shape-only confirmation
 * check), and a model call must never sit inside ingest request handling — so
 * the call went back to fire-and-forget and `result.errors` stopped being
 * reachable from it. That would have reintroduced the silent-vanish the review
 * fix existed to prevent.
 *
 * This closes the gap without blocking ingest: the failure is written to
 * `error_events`, which is durable, visible in the admin error views, and on
 * its own retention window (`retentionErrorDays`).
 *
 * It is DELIBERATELY its own module rather than a function on
 * lib/alerts/pii-alerts.ts — that module is wholesale-mocked by the receivers'
 * own tests, which would make this silently undefined at exactly the moment it
 * is supposed to fire.
 *
 * Never throws. A logger that can throw inside a catch block is worse than no
 * logger, and this one runs on an unobserved promise: an escaping rejection
 * would be unhandled.
 */
import { insertErrorEvents } from '@/lib/db/error-queries';

export async function recordPiiAlertFailure(
  surface: 'cowork' | 'code',
  messageId: string | undefined,
  error: unknown,
): Promise<void> {
  try {
    const message = error instanceof Error ? error.message : String(error);
    await insertErrorEvents([{
      severity: 'error',
      source: `otel-${surface}-receiver`,
      message: `PII alert write failed: ${message}`,
      stack_trace: error instanceof Error ? (error.stack ?? null) : null,
      context_json: JSON.stringify({ surface, message_id: messageId ?? null, kind: 'pii_alert_write_failure' }),
    }]);
  } catch {
    // The database is the thing that just failed, so a write to record that
    // failure can fail too. The console.error at the call site remains.
  }
}
