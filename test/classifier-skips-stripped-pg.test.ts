// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The Cowork classifier never judges a prompt whose text retention removed,
// and Classifier Health's queue count agrees — POSTGRES ONLY.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn().mockImplementation(() => ({ messages: { create: mockCreate } })) }));
vi.mock('@/lib/config', async (orig) => {
  const real = await orig<typeof import('@/lib/config')>();
  return { ...real, getConfigValue: async (k: string) => (k === 'anthropicAiApiKey' ? 'sk-test' : k === 'pulseClassifierModel' ? 'claude-haiku-4-5-20251001' : '') };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let cleanup: () => Promise<void>;
let sqlTag: typeof import('drizzle-orm').sql;

async function run(text: string): Promise<Array<Record<string, unknown>>> {
  const r = await db.execute(sqlTag.raw(text));
  return (r.rows ?? r) as Array<Record<string, unknown>>;
}

describe('classifier skips retention-stripped prompts (postgres)', () => {
  beforeAll(async () => {
    const { createTestDbClient } = await import('./helpers/db');
    const c = await createTestDbClient('postgres');
    db = c.client; cleanup = c.cleanup;
    sqlTag = (await import('drizzle-orm')).sql;
  }, 180_000);
  afterAll(async () => { if (cleanup) await cleanup(); });

  it('sends only readable prompts to the model', async () => {
    await run(`INSERT INTO users (id, email) VALUES ('u1', 'u1@test.local')`);
    await run(`INSERT INTO cowork_messages (id, user_id, session_id, message_type, surface, content_full, content_preview, occurred_at) VALUES
      ('live', 'u1', 's1', 'cowork_user_message', 'cowork', 'Draft the variance commentary for the board pack', 'Draft the variance', 100),
      ('gone', 'u1', 's1', 'cowork_user_message', 'cowork', NULL, '[Content removed — retention policy]', 50)`);
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify([{ event_id: 'live', tier: 2, task_type: 'analysis', frontier_push_candidate: false, capability_creation_candidate: false, confidence: 0.8 }]) }] });

    const { runClassifierJob } = await import('@/lib/pulse/classifier');
    const r = await runClassifierJob();
    expect(r.selected).toBe(1);
    const sent = mockCreate.mock.calls[0][0].messages[0].content as string;
    expect(sent).toContain('event_id: live');
    expect(sent).not.toContain('event_id: gone');
    expect((await run(`SELECT cowork_message_id FROM pulse_classifications`)).map(x => x.cowork_message_id)).toEqual(['live']);

    // A second run finds nothing: the stripped prompt is never queued.
    mockCreate.mockClear();
    expect((await runClassifierJob()).selected).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
