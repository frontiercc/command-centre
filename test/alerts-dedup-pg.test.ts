// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres coverage for the lib/alerts/** dedup conversion.
// createPiiAlertsWithDedup (pii-alerts.ts) and createFileUploadAlerts
// (file-upload-alerts.ts) read their dedup SELECT through the async Drizzle
// client. This spec proves, on Postgres:
//
//   1. PII dedup precision — THE reason for the json_extract -> ->> port.
//      Same pii_type within 24h dedupes; a DIFFERENT pii_type does not, even
//      when one type's string is a substring of the other (a naive LIKE
//      match would falsely dedup 'ssn' against an existing 'us_ssn' alert;
//      the exact ->> match must not).
//   2. File-upload dedup on file_alert_label within 24h (same exact-match
//      json operator, ported the same way).
//   3. A dedup window boundary: an alert generated just OUTSIDE the 24h
//      window is not treated as a dedup match — a fresh alert still fires.
//
// HARNESS RULE (copied from test/otel-receivers-pg.test.ts): the modules
// under test reach the database through getClient(), which binds to
// DATABASE_URL on first use, so the modules-under-test + schema are
// DYNAMIC-imported AFTER createTestDbClient() has set DATABASE_URL + reset
// modules.
import { describe, it, expect } from 'vitest';

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');

  try {
    // Dynamic imports AFTER the DATABASE_URL env + module reset (harness rule).
    const { schema } = await import('@/lib/db/schema');
    const { eq } = await import('drizzle-orm');
    const { createPiiAlertsWithDedup } = await import('@/lib/alerts/pii-alerts');
    const { createFileUploadAlerts } = await import('@/lib/alerts/file-upload-alerts');
    const { runUseCaseAtRiskAlerts } = await import('@/lib/alerts/use-case-alerts');
    type UseCase = import('@/lib/usecases/queries').UseCase;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = client as any;

    await db.insert(schema.users).values([
      { id: 'user-a', email: 'a@test.local' },
      { id: 'user-b', email: 'b@test.local' },
      { id: 'user-c', email: 'c@test.local' },
      { id: 'user-d', email: 'd@test.local' },
      { id: 'user-e', email: 'e@test.local' },
    ]);

    // ══════════════════════════════════════════════════════════════════════
    // (1a) PII dedup — SAME pii_type within 24h is deduped
    // ══════════════════════════════════════════════════════════════════════
    await createPiiAlertsWithDedup('user-a', [{ type: 'email', masked: '***' }], 'first@example.com', 'msg-a1', 'cowork');
    await createPiiAlertsWithDedup('user-a', [{ type: 'email', masked: '***' }], 'second@example.com', 'msg-a2', 'cowork');
    const userAAlerts = await db.select().from(schema.alerts).where(eq(schema.alerts.user_id, 'user-a'));
    expect(userAAlerts.length).toBe(1); // second call deduped

    // ══════════════════════════════════════════════════════════════════════
    // (1b) PII dedup PRECISION — a DIFFERENT pii_type is NOT deduped, even
    // when one type's string is a substring of the other. 'us_ssn' is
    // created first (its raw_evidence JSON contains the substring "ssn");
    // 'ssn' is then checked — a naive `raw_evidence LIKE '%ssn%'` dedup would
    // falsely match the 'us_ssn' row and skip creating this one. The exact
    // ->>'pii_type' match must NOT dedup these.
    // ══════════════════════════════════════════════════════════════════════
    await createPiiAlertsWithDedup('user-b', [{ type: 'us_ssn', masked: '***-**-6789' }], '123-45-6789', 'msg-b1', 'cowork');
    await createPiiAlertsWithDedup('user-b', [{ type: 'ssn', masked: '***-**-6789' }], '123-45-6789', 'msg-b2', 'cowork');
    const userBAlerts = await db.select().from(schema.alerts).where(eq(schema.alerts.user_id, 'user-b'));
    expect(userBAlerts.length).toBe(2); // BOTH created — proves exact-match precision

    // ══════════════════════════════════════════════════════════════════════
    // (2) Dedup window boundary — an alert generated just OUTSIDE the 24h
    // window does not dedup a fresh one with the same pii_type.
    // ══════════════════════════════════════════════════════════════════════
    const justOutside = Math.floor(Date.now() / 1000) - (24 * 3600 + 60); // 24h1m ago
    await db.insert(schema.alerts).values({
      id: 'stale-pii-alert',
      user_id: 'user-c',
      alert_type: 'policy',
      severity: 'low',
      title: 'Stale PII alert',
      explanation: 'Outside the dedup window',
      raw_evidence: { pii_type: 'phone' },
      generated_at: justOutside,
    });
    await createPiiAlertsWithDedup('user-c', [{ type: 'phone', masked: '***0100' }], '555-0100', 'msg-c1', 'cowork');
    const userCAlerts = await db.select().from(schema.alerts).where(eq(schema.alerts.user_id, 'user-c'));
    expect(userCAlerts.length).toBe(2); // stale + fresh — the stale one did NOT dedup the new one

    // ══════════════════════════════════════════════════════════════════════
    // (3) File-upload dedup on file_alert_label within 24h — same exact-match
    // json operator as (1), ported the same way.
    // ══════════════════════════════════════════════════════════════════════
    const firstFired = await createFileUploadAlerts('user-d', 'sess-d', ['cert.pem']);
    expect(firstFired).toBe(1); // built-in '*.pem' rule matches (only that one rule — no other name substring)
    const secondFired = await createFileUploadAlerts('user-d', 'sess-d', ['cert.pem']);
    expect(secondFired).toBe(0); // same label within 24h -> deduped

    const thirdFired = await createFileUploadAlerts('user-d', 'sess-d', ['id_rsa']);
    expect(thirdFired).toBe(1); // different rule/label ('SSH private key') -> not deduped

    const userDAlerts = await db.select().from(schema.alerts).where(eq(schema.alerts.user_id, 'user-d'));
    expect(userDAlerts.length).toBe(2); // one per distinct file_alert_label

    // ══════════════════════════════════════════════════════════════════════
    // (4) Substring (LIKE/ILIKE) dedup path — use-case-alerts.ts's
    // runUseCaseAtRiskAlerts casts raw_evidence to text and uses ILIKE on
    // Postgres (jsonb has no LIKE operator) rather than the exact ->> match
    // used above. Proves that cast+ILIKE actually executes on real Postgres,
    // not just type-checks.
    // ══════════════════════════════════════════════════════════════════════
    const uc: UseCase = {
      id: 'uc-dedup-001', title: 'Contract triage', description: null,
      ownerUserId: 'user-e', departments: [], surfaces: [], keywords: ['x'],
      skills: [], connectors: [], taskTypes: [], origin: 'planned',
      status: 'confirmed', lifecycle: 'piloting', lifecycleChangedAt: null,
      strategic: 0, captureMethod: 'guided', sourceExcerpt: null, createdBy: null,
      activateResult: null, lastActivatedAt: null,
      impactSummary: null, impactSummaryAt: null,
      painPoint: null, valueHypothesis: null, baselineNote: null, kpiNote: null,
      createdAt: Math.floor(Date.now() / 1000), updatedAt: Math.floor(Date.now() / 1000),
    };
    await runUseCaseAtRiskAlerts(uc, 'adopted');
    await runUseCaseAtRiskAlerts(uc, 'adopted'); // second call within 7 days -> deduped
    const userEAlerts = await db.select().from(schema.alerts).where(eq(schema.alerts.user_id, 'user-e'));
    expect(userEAlerts.length).toBe(1);
  } finally {
    await cleanup();
  }
}

describe('lib/alerts/** dedup (postgres)', () => {
  it(
    'PII dedup precision (same/different pii_type), window boundary, and file-upload label dedup behave correctly on postgres',
    async () => {
      await runSpec();
    },
    180_000,
  );
});
