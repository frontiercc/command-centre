// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// ChatGPT in human time: a conversation's working time is measured from its
// prompt and reply times into chatgpt_session_time, the hourly estimate job
// sizes Tier 2/3 conversations there (never in cowork_session_stats), and Work
// Pulse's summary counts them per the switch while the digest's org figures
// stay Claude Cowork only. POSTGRES ONLY; the model is mocked.
import { describe, it, expect, vi } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({ messages: { create: vi.fn() } })),
}));

const NOW = Math.floor(Date.now() / 1000);

async function seed(sql: TestSql): Promise<void> {
  await sql.run(`INSERT INTO users (id, email, display_name, source, first_seen_at, last_seen_at, department) VALUES
    ('u1', 'ana@example.org', 'Ana', 'openai', 1, ?, 'Finance')`, [NOW]);
  const t = NOW - 2 * 3600;
  // ChatGPT Work conversation: two prompts, two replies, 10 minutes apart each.
  await sql.run(`INSERT INTO cowork_sessions (id, conversation_id, user_id, source) VALUES ('chatgpt:c1', 'chatgpt:c1', 'u1', 'chatgpt_work')`);
  for (const [id, at, text] of [['chatgpt:m1', t, 'Build the Q3 variance pack from the ledger export'], ['chatgpt:m2', t + 1200, 'Add commentary for the three largest variances']] as const) {
    await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, content_preview, content_full, occurred_at)
      VALUES (?, 'chatgpt:c1', 'u1', 'cowork_user_message', 'cowork', 'chatgpt_work', ?, ?, ?)`, [id, text, text, at]);
    await sql.run(`INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at)
      VALUES (?, 'u1', 2, 'analysis', 0.9, 'test', ?)`, [id, at + 60]);
  }
  await sql.run(`INSERT INTO openai_replies (id, user_id, session_id, source, model, occurred_at) VALUES
    ('chatgpt-reply:r1', 'u1', 'chatgpt:c1', 'chatgpt_work', 'gpt-5.5', ?),
    ('chatgpt-reply:r2', 'u1', 'chatgpt:c1', 'chatgpt_work', 'gpt-5.5', ?)`, [t + 600, t + 1800]);
  // A Claude Cowork session already estimated, for the per-product totals.
  await sql.run(`INSERT INTO cowork_sessions (id, conversation_id, user_id) VALUES ('cw-1', 'cw-1', 'u1')`);
  await sql.run(`INSERT INTO cowork_session_stats (session_id, user_id, first_event_at, last_event_at, computed_at, active_secs, human_minutes_low, human_minutes_likely, human_minutes_high)
    VALUES ('cw-1', 'u1', ?, ?, ?, 1800, 60, 90, 120)`, [t, t + 1800, NOW]);
}

describe('ChatGPT in human time', () => {
  it('measures, estimates and counts ChatGPT conversations apart from Claude Cowork', async () => {
    const { sql, cleanup } = await createTestDatabase();
    try {
      await seed(sql);
      const { setConfigValue } = await import('@/lib/config');
      await setConfigValue('humanTimeEnabled', 'true');

      // Working time from prompts and replies: four events 10 minutes apart = 30 minutes.
      const { rollupChatgptSessionTime } = await import('@/lib/pulse/chatgpt-session-time');
      expect(await rollupChatgptSessionTime(NOW)).toBe(1);
      const time = await sql.all<{ active_secs: number; source: string }>(`SELECT active_secs, source FROM chatgpt_session_time WHERE session_id = 'chatgpt:c1'`);
      expect(time[0]).toEqual({ active_secs: 1800, source: 'chatgpt_work' });

      // The estimate job sizes the conversation and writes it to ChatGPT's own record.
      const prompts: string[] = [];
      const { runSessionEstimateJob } = await import('@/lib/pulse/session-estimates');
      const run = await runSessionEstimateJob(NOW, { callModel: async (p) => { prompts.push(p); return { text: '{"low": 120, "likely": 180, "high": 240}' }; } });
      expect(run).toMatchObject({ written: 1, refused: 0, skipped: false });
      expect(prompts[0]).toContain('Build the Q3 variance pack');
      const est = await sql.all<{ human_minutes_likely: number }>(`SELECT human_minutes_likely FROM chatgpt_session_time WHERE session_id = 'chatgpt:c1'`);
      expect(est[0].human_minutes_likely).toBe(180);
      expect((await sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM cowork_session_stats WHERE session_id LIKE 'chatgpt:%'`))[0].n).toBe(0);

      // Work Pulse: All counts both with each product's totals; each view its own.
      const { readHumanTime, readOrgHumanTime } = await import('@/lib/pulse/human-time-summary');
      const all = await readHumanTime('cowork', undefined, 'all');
      expect(all?.sessions).toBe(2);
      expect(all?.byProduct).toEqual({
        claude: { sessions: 1, humanMinutes: 90, claudeMinutes: 30 },
        openai: { sessions: 1, humanMinutes: 180, claudeMinutes: 30 },
      });
      expect((await readHumanTime('cowork', undefined, 'claude'))?.sessions).toBe(1);
      const chatgpt = await readHumanTime('cowork', undefined, 'openai');
      expect(chatgpt?.sessions).toBe(1);
      expect(chatgpt?.humanMinutes.likely).toBe(180);

      // The digest, Highlights, Reports and the Connector stay Claude Cowork only.
      const org = await readOrgHumanTime(NOW - 30 * 86400, NOW + 60);
      expect(org?.cowork.sessions).toBe(1);

      // Erasure removes the person's ChatGPT working time.
      const { deleteUserData } = await import('@/lib/db/queries');
      await deleteUserData('u1');
      expect((await sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM chatgpt_session_time`))[0].n).toBe(0);
    } finally {
      await cleanup();
    }
  }, 120_000);
});
