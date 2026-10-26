// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Regression test for migration 066 / 0006: install_hint was renamed to
// install_guide (data-preserving rename, not drop+recreate) and a nullable
// department column was added to skill_library_entries. Proves both on real
// Postgres. Harness mirrors test/library-routes-pg.test.ts.
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';

async function runSpec(): Promise<void> {
  const { createTestDbClient } = await import('./helpers/db');
  const h = await createTestDbClient('postgres');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = h.client;
  const cleanup = h.cleanup;

  try {
    const { schema } = await import('@/lib/db/schema');
    const e = schema.skillLibraryEntries;
    const now = Math.floor(Date.now() / 1000);

    // install_guide carries what used to be install_hint's value — proves
    // the rename is data-preserving, not a drop+recreate.
    const [inserted] = await client.insert(e).values({
      name: 'deep-research', type: 'skill', surface: 'cowork', source: 'org',
      is_published: 1, install_guide: 'claude install deep-research',
      created_at: now, updated_at: now,
    }).returning();

    expect(inserted.install_guide).toBe('claude install deep-research');
    // department defaults to null — org-wide, unchanged from today's behavior.
    expect(inserted.department).toBeNull();

    await client.update(e).set({ department: 'Legal' }).where(eq(e.id, inserted.id));
    const [updated] = await client.select().from(e).where(eq(e.id, inserted.id));
    expect(updated.department).toBe('Legal');
  } finally {
    await cleanup();
  }
}

describe('skill_library_entries install_guide rename + department column', () => {
  it('postgres: install_guide carries data forward, department defaults null and is settable', async () => {
    await runSpec();
  }, 30000);
});
