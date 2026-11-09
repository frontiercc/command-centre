// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Work Pulse sorts Claude Chat prompts (cowork_messages, surface 'chat') into
// tiers like Cowork prompts; Claude Code prompts stay Developer Pulse's.
// POSTGRES ONLY.
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

describe('Work Pulse classifier includes Claude Chat (postgres)', () => {
  beforeAll(async () => {
    const { createTestDbClient } = await import('./helpers/db');
    const c = await createTestDbClient('postgres');
    db = c.client; cleanup = c.cleanup;
    sqlTag = (await import('drizzle-orm')).sql;
  }, 180_000);
  afterAll(async () => { if (cleanup) await cleanup(); });

  it('classifies Cowork and Claude Chat prompts, never Claude Code ones', async () => {
    await run(`INSERT INTO users (id, email) VALUES ('u1', 'u1@test.local')`);
    await run(`INSERT INTO cowork_messages (id, user_id, session_id, message_type, surface, source, content_full, content_preview, occurred_at) VALUES
      ('cowork-1', 'u1', 's1', 'cowork_user_message', 'cowork', 'otel', 'Draft the variance commentary for the board pack', 'Draft the variance', 100),
      ('chat-1', 'u1', 'conv-1', 'cowork_user_message', 'chat', 'compliance', 'Compare these two supplier contracts and list the risks', 'Compare these two', 110),
      ('code-1', 'u1', 'code-s1', 'cowork_user_message', 'code', 'otel', 'Add pagination to the orders endpoint', 'Add pagination', 120)`);
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify([
      { event_id: 'cowork-1', tier: 2, task_type: 'analysis', frontier_push_candidate: false, capability_creation_candidate: false, confidence: 0.8 },
      { event_id: 'chat-1', tier: 3, task_type: 'analysis', frontier_push_candidate: false, capability_creation_candidate: false, confidence: 0.8 },
    ]) }] });

    const { runClassifierJob } = await import('@/lib/pulse/classifier');
    const r = await runClassifierJob();
    expect(r.selected).toBe(2);
    const sent = mockCreate.mock.calls[0][0].messages[0].content as string;
    expect(sent).toContain('event_id: chat-1');
    expect(sent).not.toContain('event_id: code-1');
    const classified = (await run(`SELECT cowork_message_id, tier FROM pulse_classifications ORDER BY cowork_message_id`))
      .map(x => [x.cowork_message_id, Number(x.tier)]);
    expect(classified).toEqual([['chat-1', 3], ['cowork-1', 2]]);
  });
});
