// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Claude Chat on Postgres: a conversation produced something when a reply made an artifact or a
// generated file (chat_assistant_meta), and one with no reply on record is not measured. The
// Overview's Produced card and the By product panel both read it, and Document sessions counts
// the files attached in Claude Chat.
import { describe, it, expect } from 'vitest';

async function runSpec(): Promise<void> {
  const { createTestDatabase } = await import('./helpers/db');
  const { sql, cleanup } = await createTestDatabase();
  try {
    const { buildSessionOutputRate } = await import('@/lib/pulse/cowork/session-output-rate');
    const { buildByProduct } = await import('@/lib/pulse/cowork/by-product');
    const { getDocSessions } = await import('@/lib/pulse/cowork/doc-sessions');
    const nowS = Math.floor(Date.now() / 1000);
    // Ten days ago: inside the Produced card's completed weeks and By product's 30 days.
    const t = nowS - 10 * 86400;

    await sql.run(`INSERT INTO users (id, email, display_name, first_seen_at, last_seen_at) VALUES ('ch', 'chat@example.com', 'ch', ?, ?)`, [t, t]);
    for (let i = 1; i <= 6; i++) {
      await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, content_full, occurred_at)
                     VALUES (?, ?, 'ch', 'cowork_user_message', 'chat', 'compliance', 'text', ?)`, [`p${i}`, `c${i}`, t]);
    }
    const reply = (conversation: string, artifacts: number, files: number) =>
      sql.run(`INSERT INTO chat_assistant_meta (id, conversation_id, user_id, model, artifacts_count, generated_files_count, occurred_at)
               VALUES (?, ?, 'ch', 'claude-sonnet-5', ?, ?, ?)`, [`r-${conversation}`, conversation, artifacts, files, t]);
    // c1 to c3 made an artifact, c4 a generated file, c5 nothing; c6 has no reply on record.
    for (const c of ['c1', 'c2', 'c3']) await reply(c, 1, 0);
    await reply('c4', 0, 1);
    await reply('c5', 0, 0);

    // Produced card: five measured conversations, four produced something; c6 is left out.
    const card = await buildSessionOutputRate(nowS);
    expect(card.sessions).toBe(5);
    expect(card.produced).toBe(4);
    expect(card.rate).toBeCloseTo(0.8, 6);

    // By product: Claude Chat's row and All products both read 80%.
    const panel = (await buildByProduct(nowS))!;
    expect(panel.rows.find(r => r.product === 'claude_chat')!.producedPct).toBe(80);
    expect(panel.total.producedPct).toBe(80);

    // Document sessions: the two files attached in one Claude Chat conversation count on the Claude side.
    await sql.run(`INSERT INTO cowork_sessions (id, conversation_id, user_id, source, started_at, files_uploaded)
                   VALUES ('c1', 'c1', 'ch', 'compliance', ?, '["brief.pdf","figures.xlsx"]')`, [t]);
    expect(await getDocSessions({ since: nowS - 30 * 86400, vendor: 'all' })).toEqual({ sessions_with_uploads: 1, total_uploads: 2 });
    expect(await getDocSessions({ since: nowS - 30 * 86400, vendor: 'claude' })).toEqual({ sessions_with_uploads: 1, total_uploads: 2 });
    expect(await getDocSessions({ since: nowS - 30 * 86400, vendor: 'openai' })).toEqual({ sessions_with_uploads: 0, total_uploads: 0 });
  } finally {
    await cleanup();
  }
}

describe('Claude Chat output and uploads (postgres)', () => {
  it('reads what Claude Chat replies made, and the files attached in it', async () => {
    await runSpec();
  }, 180_000);
});
