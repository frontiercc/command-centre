// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from './helpers/db';

describe('github user attribution tables (migration 069)', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const testDb = await createTestDatabase();
    cleanup = testDb.cleanup;
  });

  afterAll(async () => cleanup());

  it('round-trips rows through all three new tables', async () => {
    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const client = await getTypedClient();
    const now = Math.floor(Date.now() / 1000);

    await client.insert(schema.githubUserRepoStats).values({
      user_id: 'u-attr-test', repo: 'org/repo-a', date: '2026-08-01', commit_count: 3, synced_at: now,
    }).onConflictDoNothing();
    await client.insert(schema.githubIdentityMap).values({
      identity: 'login:testuser', user_id: 'u-attr-test', created_at: now, created_by: null,
    }).onConflictDoNothing();
    await client.insert(schema.githubUnmatchedAuthors).values({
      identity: 'ghost@example.com', commit_count: 7, last_synced: now,
    }).onConflictDoNothing();

    const stats = await client.select().from(schema.githubUserRepoStats)
      .where(eq(schema.githubUserRepoStats.user_id, 'u-attr-test'));
    expect(stats[0]?.commit_count).toBe(3);
    const map = await client.select().from(schema.githubIdentityMap)
      .where(eq(schema.githubIdentityMap.identity, 'login:testuser'));
    expect(map[0]?.user_id).toBe('u-attr-test');
    const unmatched = await client.select().from(schema.githubUnmatchedAuthors)
      .where(eq(schema.githubUnmatchedAuthors.identity, 'ghost@example.com'));
    expect(unmatched[0]?.commit_count).toBe(7);

    // cleanup
    await client.delete(schema.githubUserRepoStats).where(eq(schema.githubUserRepoStats.user_id, 'u-attr-test'));
    await client.delete(schema.githubIdentityMap).where(eq(schema.githubIdentityMap.identity, 'login:testuser'));
    await client.delete(schema.githubUnmatchedAuthors).where(eq(schema.githubUnmatchedAuthors.identity, 'ghost@example.com'));
  });
});
