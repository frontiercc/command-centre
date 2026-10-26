// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// deleteUserData (GDPR erasure) must cover the two per-user
// GitHub attribution tables introduced in migration 069:
// github_user_repo_stats and github_identity_map. github_unmatched_authors
// is deliberately NOT covered — it is identity-keyed (not user-keyed) and
// self-rewrites on every sync, so there is nothing user-scoped to erase.
//
// Mirrors test/github-user-attribution-schema.test.ts's DB setup idiom
// (createTestDatabase() + dynamic-imported client/schema) and
// test/queries-cowork-chat-gdpr-pg.test.ts's deleteUserData calling
// convention (seed two users, erase one, assert selectivity).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from './helpers/db';

describe('GDPR erasure — github attribution tables (migration 069)', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const testDb = await createTestDatabase();
    cleanup = testDb.cleanup;
  });

  afterAll(async () => cleanup());

  it('deleteUserData erases the target user\'s github_user_repo_stats + github_identity_map rows while leaving another user\'s rows intact', async () => {
    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const { deleteUserData } = await import('@/lib/db/queries');
    const client = await getTypedClient();
    const now = Math.floor(Date.now() / 1000);

    // Seed two users.
    await client.insert(schema.users).values([
      { id: 'gdpr-gh-erase', email: 'gdpr-gh-erase@test.local', display_name: 'Erase Me' },
      { id: 'gdpr-gh-keep', email: 'gdpr-gh-keep@test.local', display_name: 'Keep Me' },
    ]);

    // One github_user_repo_stats row + one github_identity_map row for EACH user.
    await client.insert(schema.githubUserRepoStats).values([
      { user_id: 'gdpr-gh-erase', repo: 'org/repo-erase', date: '2026-08-01', commit_count: 3, synced_at: now },
      { user_id: 'gdpr-gh-keep', repo: 'org/repo-keep', date: '2026-08-01', commit_count: 5, synced_at: now },
    ]);
    await client.insert(schema.githubIdentityMap).values([
      { identity: 'login:erase-user', user_id: 'gdpr-gh-erase', created_at: now, created_by: null },
      { identity: 'login:keep-user', user_id: 'gdpr-gh-keep', created_at: now, created_by: null },
    ]);

    const result = await deleteUserData('gdpr-gh-erase');
    expect(result).not.toBeNull();

    // Erased user's rows are gone from both tables.
    expect(
      (await client.select().from(schema.githubUserRepoStats).where(eq(schema.githubUserRepoStats.user_id, 'gdpr-gh-erase'))).length,
    ).toBe(0);
    expect(
      (await client.select().from(schema.githubIdentityMap).where(eq(schema.githubIdentityMap.user_id, 'gdpr-gh-erase'))).length,
    ).toBe(0);

    // Kept user's rows in the same two tables survive untouched (selectivity proof).
    const keepStats = await client.select().from(schema.githubUserRepoStats).where(eq(schema.githubUserRepoStats.user_id, 'gdpr-gh-keep'));
    expect(keepStats.length).toBe(1);
    expect(keepStats[0].commit_count).toBe(5);
    const keepMap = await client.select().from(schema.githubIdentityMap).where(eq(schema.githubIdentityMap.user_id, 'gdpr-gh-keep'));
    expect(keepMap.length).toBe(1);
    expect(keepMap[0].identity).toBe('login:keep-user');
  });
});
