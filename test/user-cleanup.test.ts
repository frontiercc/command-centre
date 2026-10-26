// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Bug: a brand-new OTel-prepopulated user (first_seen_at = now, last_seen_at =
// NULL — see app/api/admin/otel-prepopulate/route.ts) was being deactivated by
// the very next daily runUserCleanup() run, with zero grace period, because the
// old query treated `last_seen_at IS NULL` as unconditionally stale. Real users
// (e.g. a real user on a production deployment) were flagged `stale_otel_auto` before they
// had ever sent a single event, then genuinely started using the tool days
// later — but stayed stuck deactivated since nothing auto-clears the flag.
//
// Harness: follows test/retention-cleanup-code-meta.test.ts — createTestDatabase()
// (runs the full migration set), dynamic imports of getTypedClient/schema/
// runUserCleanup AFTER createTestDatabase() so they bind to the fresh test DB file,
// real setConfigValue (no @/lib/config mock).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from './helpers/db';

const NOW = Math.floor(Date.now() / 1000);
const daysAgo = (d: number) => NOW - d * 86400;

describe('runUserCleanup — never-seen OTel users get a grace period', () => {
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDatabase();
    cleanup = t.cleanup;
  });

  afterEach(async () => cleanup());

  it('does not deactivate a never-seen user still inside the grace period', async () => {
    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const client = await getTypedClient();

    await client.insert(schema.users).values({
      id: 'u-new', email: 'new.user@example.com', source: 'otel',
      first_seen_at: daysAgo(2), last_seen_at: null, deactivated_at: null,
    });

    const { runUserCleanup } = await import('@/lib/jobs/user-cleanup');
    const result = await runUserCleanup();

    const [row] = await client.select().from(schema.users).where(eq(schema.users.id, 'u-new'));
    expect(row.deactivated_at).toBeNull();
    expect(result.deactivated).toBe(0);
  });

  it('deactivates a never-seen user once the grace period has elapsed', async () => {
    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const client = await getTypedClient();

    await client.insert(schema.users).values({
      id: 'u-stale-new', email: 'stale.new@example.com', source: 'otel',
      first_seen_at: daysAgo(40), last_seen_at: null, deactivated_at: null,
    });

    const { runUserCleanup } = await import('@/lib/jobs/user-cleanup');
    const result = await runUserCleanup();

    const [row] = await client.select().from(schema.users).where(eq(schema.users.id, 'u-stale-new'));
    expect(row.deactivated_at).not.toBeNull();
    expect(row.deactivation_reason).toBe('stale_otel_auto');
    expect(result.deactivated).toBe(1);
  });

  it('still deactivates a previously-seen user who has genuinely gone stale', async () => {
    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const client = await getTypedClient();

    await client.insert(schema.users).values({
      id: 'u-went-quiet', email: 'went.quiet@example.com', source: 'otel',
      first_seen_at: daysAgo(90), last_seen_at: daysAgo(40), deactivated_at: null,
    });

    const { runUserCleanup } = await import('@/lib/jobs/user-cleanup');
    await runUserCleanup();

    const [row] = await client.select().from(schema.users).where(eq(schema.users.id, 'u-went-quiet'));
    expect(row.deactivated_at).not.toBeNull();
    expect(row.deactivation_reason).toBe('stale_otel_auto');
  });

  it('does not touch a user active within the window', async () => {
    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const client = await getTypedClient();

    await client.insert(schema.users).values({
      id: 'u-active', email: 'active@example.com', source: 'otel',
      first_seen_at: daysAgo(90), last_seen_at: daysAgo(5), deactivated_at: null,
    });

    const { runUserCleanup } = await import('@/lib/jobs/user-cleanup');
    await runUserCleanup();

    const [row] = await client.select().from(schema.users).where(eq(schema.users.id, 'u-active'));
    expect(row.deactivated_at).toBeNull();
  });
});
