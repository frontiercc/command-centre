// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The flag_reason read-modify-write on a real postgres:16. Every live
// deployment runs Postgres.
//
// HARNESS RULE (same as test/otel-receivers-pg.test.ts): getClient() binds to
// DATABASE_URL on first use, so the module under test
// and `schema` are DYNAMIC-imported after createTestDbClient('postgres') has
// set DATABASE_URL and reset the module registry.
//
// createTestDbClient('postgres') runs the full lib/db/migrations-pg set via
// startPg(), so no manual DDL is needed.
import { describe, it, expect, vi } from 'vitest';

// Hoisted. The real call is covered by test/pii-confirm.test.ts; this file is
// about what the database ends up holding.
vi.mock('@/lib/pii/confirm', async (orig) => ({
  ...(await orig<typeof import('@/lib/pii/confirm')>()),
  confirmPiiMatch: async () => ({ verdict: 'dismissed' as const, reason: 'a purchase order reference, not a NI number' }),
}));

async function runSpec(seededReason: string): Promise<{
  flagReason: string | null; flagged: number; alertCount: number;
}> {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');

  try {
    const { schema } = await import('@/lib/db/schema');
    const { createPiiAlertsWithDedup } = await import('@/lib/alerts/pii-alerts');
    const { eq } = await import('drizzle-orm');
    // `client` is the DrizzleClient union, whose insert()/select() signatures
    // don't unify — the established cast in every other *-pg test
    // (config-pg, admin-queries-pg, session-output-rate-pg) rather than a
    // second typed client.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = client as any;

    const now = Math.floor(Date.now() / 1000);
    await db.insert(schema.users).values({ id: 'u1', email: 'u1@test.local' });
    await db.insert(schema.coworkMessages).values({
      id: 'm1', session_id: 's1', user_id: 'u1', message_type: 'cowork_user_message',
      content_full: 'ref AB123456C', flagged: 1, flag_reason: seededReason,
      occurred_at: now, surface: 'cowork', source: 'otel',
    });

    await createPiiAlertsWithDedup('u1', [{ type: 'nino', masked: 'AB****56C' }],
      'ref AB123456C', 'm1', 'cowork',
    );

    const rows = await db
      .select({ flag_reason: schema.coworkMessages.flag_reason, flagged: schema.coworkMessages.flagged })
      .from(schema.coworkMessages)
      .where(eq(schema.coworkMessages.id, 'm1'));
    const alerts = await db.select({ id: schema.alerts.id }).from(schema.alerts);

    return {
      flagReason: rows[0]?.flag_reason ?? null,
      flagged: Number(rows[0]?.flagged ?? 0),
      alertCount: alerts.length,
    };
  } finally {
    await cleanup();
  }
}

describe('PII confirmation — postgres', () => {
  it('raises no alert, records the dismissal, and leaves flagged set', async () => {
    const r = await runSpec('PII detected: nino');
    expect(r.alertCount).toBe(0);
    expect(r.flagReason).toBe('PII detected: nino (dismissed)');
    // Postgres returns integer columns as strings — Number() above is load-bearing.
    expect(r.flagged).toBe(1);
  }, 120_000);

  it('preserves an intent segment that landed before the verdict', async () => {
    const r = await runSpec('PII detected: nino | Intent detected: data_exfiltration (high)');
    expect(r.flagReason).toBe('PII detected: nino (dismissed) | Intent detected: data_exfiltration (high)');
  }, 120_000);
});
