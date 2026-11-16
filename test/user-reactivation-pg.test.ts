// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// A user the stale-user cleanup switched off ('stale_otel_auto') comes back as
// soon as they are active again: on their next telemetry (resolveOtelUser, used
// by the Cowork, Code and Office receivers) and, for anyone already wrongly
// switched off, on the next daily cleanup run. A user an admin deactivated by
// hand ('manual_admin') is never switched back on automatically.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const NOW = Math.floor(Date.now() / 1000);
const daysAgo = (d: number) => NOW - d * 86400;

let cleanup: () => Promise<void>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let schema: any;

const row = async (id: string) => {
  const { eq } = await import('drizzle-orm');
  const rows = await client.select().from(schema.users).where(eq(schema.users.id, id));
  return rows[0];
};

beforeAll(async () => {
  const { createTestDbClient } = await import('./helpers/db');
  const h = await createTestDbClient('postgres');
  cleanup = h.cleanup;
  client = h.client;
  ({ schema } = await import('@/lib/db/schema'));

  await client.insert(schema.users).values([
    // Switched off by the cleanup, now sending telemetry again.
    { id: 'auto-back', email: 'Auto.Back@corp.com', source: 'otel', first_seen_at: daysAgo(90), last_seen_at: daysAgo(40), deactivated_at: daysAgo(9), deactivation_reason: 'stale_otel_auto' },
    // Switched off by an admin, now sending telemetry again.
    { id: 'manual-off', email: 'manual.off@corp.com', source: 'otel', first_seen_at: daysAgo(90), last_seen_at: daysAgo(40), deactivated_at: daysAgo(9), deactivation_reason: 'manual_admin' },
    // Reached through an admin merge (alias), switched off by the cleanup.
    { id: 'alias-target', email: 'primary@corp.com', source: 'otel', first_seen_at: daysAgo(90), last_seen_at: daysAgo(40), deactivated_at: daysAgo(9), deactivation_reason: 'stale_otel_auto' },
    // Already wrongly switched off: active since, so the next cleanup restores them.
    { id: 'auto-active-since', email: 'active.since@corp.com', source: 'otel', first_seen_at: daysAgo(90), last_seen_at: daysAgo(2), deactivated_at: daysAgo(9), deactivation_reason: 'stale_otel_auto' },
    // Switched off by the cleanup and still quiet: stays off.
    { id: 'auto-still-quiet', email: 'still.quiet@corp.com', source: 'otel', first_seen_at: daysAgo(90), last_seen_at: daysAgo(45), deactivated_at: daysAgo(9), deactivation_reason: 'stale_otel_auto' },
    // Switched off by an admin, active since: stays off.
    { id: 'manual-active-since', email: 'manual.active@corp.com', source: 'otel', first_seen_at: daysAgo(90), last_seen_at: daysAgo(2), deactivated_at: daysAgo(9), deactivation_reason: 'manual_admin' },
  ]);
  await client.insert(schema.otelIdentityAliases).values({ email: 'second@corp.com', user_id: 'alias-target', created_at: NOW });
}, 120_000);

afterAll(async () => cleanup?.());

const seen = (email: string) => ({ email, installationId: null, displayName: 'X', department: null, surface: 'cowork' as const, nowS: NOW, eventCount: 1 });

describe('returning users are reactivated', () => {
  it('telemetry from an auto-deactivated user switches them back on (email match, any case)', async () => {
    const { resolveOtelUser } = await import('@/lib/otel/resolve-user');
    const r = await resolveOtelUser(client, seen('auto.back@corp.com'));
    expect(r.userId).toBe('auto-back');
    const u = await row('auto-back');
    expect(u.deactivated_at).toBeNull();
    expect(u.deactivation_reason).toBeNull();
  });

  it('telemetry through an admin merge (alias) switches the merged user back on', async () => {
    const { resolveOtelUser } = await import('@/lib/otel/resolve-user');
    const r = await resolveOtelUser(client, seen('second@corp.com'));
    expect(r.userId).toBe('alias-target');
    expect((await row('alias-target')).deactivated_at).toBeNull();
  });

  it('telemetry never undoes an admin deactivation', async () => {
    const { resolveOtelUser } = await import('@/lib/otel/resolve-user');
    await resolveOtelUser(client, seen('manual.off@corp.com'));
    const u = await row('manual-off');
    expect(u.deactivated_at).not.toBeNull();
    expect(u.deactivation_reason).toBe('manual_admin');
  });

  it('the daily cleanup restores auto-deactivated users active within the limit, and only them', async () => {
    const { runUserCleanup } = await import('@/lib/jobs/user-cleanup');
    const result = await runUserCleanup();
    expect(result.reactivated).toBe(1);
    expect((await row('auto-active-since')).deactivated_at).toBeNull();
    expect((await row('auto-still-quiet')).deactivation_reason).toBe('stale_otel_auto');
    expect((await row('manual-active-since')).deactivation_reason).toBe('manual_admin');
  });
});
