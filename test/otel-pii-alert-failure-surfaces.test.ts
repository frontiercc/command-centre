// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Regression guard: a PII alert that fails to write must never vanish.
//
// Originally createPiiAlertsWithDedup was called fire-and-forget with a bare
// `.catch(console.error)`, so a write failure was swallowed and a security
// signal could disappear with no trace. The task 3.1c review fix made the
// call AWAITED inside the per-record try/catch, so failures landed in
// `result.errors`, and this test guarded that.
//
// A Claude call was added inside that function (the shape-only PII
// confirmation check). A model call must never sit inside ingest request
// handling, so the call went back to fire-and-forget and `result.errors` is
// no longer reachable from it. The GUARANTEE is unchanged — only where the
// failure is recorded moved: it is now written to `error_events`, which is
// durable, admin-visible and on its own retention window.
//
// This test mocks createPiiAlertsWithDedup to reject and asserts the failure
// is recorded in error_events for BOTH receivers. If either receiver drops
// the recorder from its .catch(), the rejection becomes console-only and this
// test fails.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

vi.mock('@/lib/alerts/pii-alerts', () => ({
  createPiiAlertsWithDedup: vi.fn().mockRejectedValue(new Error('simulated PII alert insert failure')),
}));

const FAILURE_MESSAGE = 'simulated PII alert insert failure';

// The receivers hand the failure to recordPiiAlertFailure on an unobserved
// promise, so the assertion has to wait for that microtask chain to settle
// rather than assume it completed by the time processOtlpLogs resolved.
async function waitForErrorEvent(sql: TestSql): Promise<Array<{ source: string; message: string; context_json: string | null }>> {
  for (let i = 0; i < 50; i++) {
    const rows = await sql.all<{ source: string; message: string; context_json: string | null }>(
      "SELECT source, message, context_json FROM error_events WHERE message LIKE '%PII alert write failed%'",
    );
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  return [];
}

let sql: TestSql;
let cleanup: () => Promise<void>;
let processOtlpLogs: typeof import('@/lib/otel/cowork-receiver').processOtlpLogs;
let processCodeOtlpLogs: typeof import('@/lib/otel/code-receiver').processCodeOtlpLogs;

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
  ({ processOtlpLogs } = await import('@/lib/otel/cowork-receiver'));
  ({ processCodeOtlpLogs } = await import('@/lib/otel/code-receiver'));
});

afterAll(async () => cleanup());

function makePayload(serviceName: string, eventName: string, attrs: Record<string, string> = {}) {
  return {
    resourceLogs: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: serviceName } },
          { key: 'user.email', value: { stringValue: 'pii-failure-test@example.com' } },
          { key: 'user.id', value: { stringValue: 'usr_pii_fail_01' } },
          { key: 'organization.id', value: { stringValue: 'org_test' } },
        ],
      },
      scopeLogs: [{
        logRecords: [{
          attributes: [
            { key: 'event.name', value: { stringValue: eventName } },
            { key: 'session.id', value: { stringValue: 'sess_pii_fail_001' } },
            { key: 'prompt.id', value: { stringValue: 'prompt_pii_fail_001' } },
            ...Object.entries(attrs).map(([key, value]) => ({ key, value: { stringValue: value } })),
          ],
          timeUnixNano: '1750000000000000000',
        }],
      }],
    }],
  };
}

describe('PII alert write failure is recorded durably (regression guard)', () => {
  beforeEach(async () => {
    // A record re-sent with an identical payload is now skipped as already
    // processed (lib/otel/event-key.ts); tests reuse payloads, so clear it first.
    await sql.run('DELETE FROM otel_ingested_events');
    await sql.run(`DELETE FROM cowork_messages WHERE session_id IN
      (SELECT id FROM cowork_sessions WHERE user_id IN (SELECT id FROM users WHERE email = 'pii-failure-test@example.com'))
      OR user_id IN (SELECT id FROM users WHERE email = 'pii-failure-test@example.com')`);
    await sql.run("DELETE FROM cowork_sessions WHERE user_id IN (SELECT id FROM users WHERE email = 'pii-failure-test@example.com')");
    await sql.run("DELETE FROM users WHERE email = 'pii-failure-test@example.com'");
    await sql.run("DELETE FROM error_events WHERE message LIKE '%PII alert write failed%'");
  });

  it('cowork receiver: user_prompt with PII whose alert insert fails is recorded in error_events', async () => {
    await processOtlpLogs(
      makePayload('cowork', 'claude_code.user_prompt', { prompt: 'contact john@example.com for details' }),
    );

    const errs = await waitForErrorEvent(sql);
    expect(errs.length).toBeGreaterThanOrEqual(1);
    expect(errs.some((e) => e.message.includes(FAILURE_MESSAGE))).toBe(true);
    expect(errs.some((e) => e.source === 'otel-cowork-receiver')).toBe(true);
    expect(errs.some((e) => (e.context_json ?? '').includes('pii_alert_write_failure'))).toBe(true);

    // The message row insert happened inside the sync transaction (which
    // commits before the deferred PII-alert await runs) — it is still
    // flagged, even though the alert-table notification failed.
    const row = await sql.get<{ flagged: number; flag_reason: string }>(
      "SELECT flagged, flag_reason FROM cowork_messages WHERE prompt_id = 'prompt_pii_fail_001'",
    );
    expect(row?.flagged).toBe(1);
    expect(row?.flag_reason).toContain('PII detected');
  });

  it('code receiver: user_prompt with PII whose alert insert fails is recorded in error_events', async () => {
    await processCodeOtlpLogs(
      makePayload('claude-code', 'claude_code.user_prompt', { prompt: 'contact john@example.com for details' }),
    );

    const errs = await waitForErrorEvent(sql);
    expect(errs.length).toBeGreaterThanOrEqual(1);
    expect(errs.some((e) => e.message.includes(FAILURE_MESSAGE))).toBe(true);
    expect(errs.some((e) => e.source === 'otel-code-receiver')).toBe(true);

    const row = await sql.get<{ flagged: number; flag_reason: string }>(
      "SELECT flagged, flag_reason FROM cowork_messages WHERE prompt_id = 'prompt_pii_fail_001' AND surface = 'code'",
    );
    expect(row?.flagged).toBe(1);
    expect(row?.flag_reason).toContain('PII detected');
  });
});
