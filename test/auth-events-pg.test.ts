// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Postgres coverage for lib/db/auth-events.ts (logAuthEvent).
//
// HARNESS RULE: auth-events.ts reaches the database through getClient(),
// which binds to DATABASE_URL on first use, so the module under test is
// DYNAMIC-imported AFTER createTestDbClient() has set DATABASE_URL and reset
// modules.
import { describe, it, expect } from 'vitest';

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const { client, cleanup } = await createTestDbClient('postgres');
  try {
    const { logAuthEvent } = await import('@/lib/db/auth-events');
    const { schema } = await import('@/lib/db/schema');
    const { desc } = await import('drizzle-orm');

    await logAuthEvent({ eventType: 'test_event_1', details: 'first' });
    await logAuthEvent({ eventType: 'test_event_2', ipAddress: '127.0.0.1', details: 'second' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (client as any).select().from(schema.authEvents).orderBy(desc(schema.authEvents.id));
    const second = rows.find((r: { event_type: string }) => r.event_type === 'test_event_2');
    const first = rows.find((r: { event_type: string }) => r.event_type === 'test_event_1');
    expect(first?.details).toBe('first');
    expect(first?.ip_address).toBeNull();
    expect(second?.ip_address).toBe('127.0.0.1');
    expect(second?.details).toBe('second');
    expect(second?.agent_id).toBeNull();
    expect(typeof second?.created_at).toBe('number');
  } finally {
    await cleanup();
  }
}

describe('auth-events (postgres)', () => {
  it('logAuthEvent writes a row to auth_events', async () => {
    await runSpec();
  }, 180_000);
});
