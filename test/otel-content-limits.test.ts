// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Retention strip mode must blank rows stored at the NEW caps (250/4000)
// exactly as it did at the old ones — strip keys on age, never on length.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import { CONTENT_PREVIEW_CHARS, CONTENT_FULL_CHARS } from '@/lib/otel/content-limits';

const NOW = Math.floor(Date.now() / 1000);
const daysAgo = (d: number) => NOW - d * 86400;
const STRIPPED_MARKER = '[Content removed — retention policy]';

describe('content limits × retention strip', () => {
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDatabase();
    cleanup = t.cleanup;
    const cfg = await import('@/lib/config');
    await cfg.setConfigValue('retentionMode', 'strip');
    await cfg.setConfigValue('archiveEnabled', 'false');
    await cfg.setConfigValue('retentionCoworkDays', '30');
  });
  afterEach(async () => cleanup());

  it('constants hold the agreed values', () => {
    expect(CONTENT_PREVIEW_CHARS).toBe(250);
    expect(CONTENT_FULL_CHARS).toBe(4000);
  });

  it('strips a max-length row past the cutoff', async () => {
    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const { eq } = await import('drizzle-orm');
    const client = await getTypedClient();

    await client.insert(schema.users).values({ id: 'u-cl', email: 'cl@test.local' } as never);
    await client.insert(schema.coworkMessages).values({
      id: 'm-cl-old',
      session_id: 's-cl',
      user_id: 'u-cl',
      message_type: 'cowork_user_message',
      surface: 'cowork',
      content_preview: 'p'.repeat(CONTENT_PREVIEW_CHARS),
      content_full: 'f'.repeat(CONTENT_FULL_CHARS),
      occurred_at: daysAgo(45),
    } as never);

    const { runRetentionCleanup } = await import('@/lib/retention/cleanup');
    await runRetentionCleanup();

    const row = (await client.select().from(schema.coworkMessages)
      .where(eq(schema.coworkMessages.id, 'm-cl-old')))[0];
    expect(row.content_full).toBeNull();
    expect(row.content_preview).toBe(STRIPPED_MARKER);
  });
});
