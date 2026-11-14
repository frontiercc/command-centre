// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Work Pulse Team coaching on Postgres reads every platform Work Pulse covers: Claude Cowork,
// Claude Chat and ChatGPT, narrowed by the All / Claude / ChatGPT switch. Someone who works only in
// ChatGPT is not "hardly used" because their conversations have no Claude session stats, and a
// Claude Chat conversation counts as producing something when a reply made an artifact or a file.
import { describe, it, expect } from 'vitest';

async function runSpec(): Promise<void> {
  const { createTestDatabase } = await import('./helpers/db');
  const { sql, cleanup } = await createTestDatabase();
  try {
    const { getCoworkCoachingFigures } = await import('@/lib/pulse/cowork/coaching-figures');
    const { readWorkSessions } = await import('@/lib/pulse/cowork/work-sessions');
    const nowS = Math.floor(Date.now() / 1000);
    const t = nowS - 2 * 86400;

    for (const id of ['cw', 'ch', 'gpt']) {
      await sql.run(`INSERT INTO users (id, email, display_name, department, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'Finance', ?, ?)`,
        [id, `${id}@example.com`, id, t, t]);
    }
    let n = 0;
    const prompt = async (session: string, user: string, surface: string, source: string, tier: number) => {
      const id = `m${++n}`;
      await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, content_full, occurred_at)
                     VALUES (?, ?, ?, 'cowork_user_message', ?, ?, 'text', ?)`, [id, session, user, surface, source, t]);
      await sql.run(`INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at)
                     VALUES (?, ?, ?, 'analysis', 0.9, 'test', ?)`, [id, user, tier, nowS]);
    };

    // Claude Cowork: two sessions with prompts, all Tier 2, and a third session with stats only.
    for (const s of ['cw-s1', 'cw-s2']) { await prompt(s, 'cw', 'cowork', 'otel', 2); await prompt(s, 'cw', 'cowork', 'otel', 2); }
    const stats = async (session: string, active: number, produced: number, human: number | null) => {
      await sql.run(`INSERT INTO cowork_sessions (id, conversation_id, user_id, source, started_at) VALUES (?, ?, 'cw', 'otel', ?)`, [session, session, t]);
      await sql.run(`INSERT INTO cowork_session_stats (session_id, user_id, computed_at, first_event_at, last_event_at, active_secs, produced_output, human_minutes_likely)
                     VALUES (?, 'cw', ?, ?, ?, ?, ?, ?)`, [session, nowS, t, t, active, produced, human]);
    };
    await stats('cw-s1', 600, 1, 60);
    await stats('cw-s2', 300, 0, 30);
    await stats('cw-s3', 100, 0, null);

    // Claude Chat: three conversations, all Tier 1. A reply in ch-1 made an artifact; ch-2's reply
    // made nothing; ch-3 has no reply on record, so it is not measured.
    for (const s of ['ch-1', 'ch-2']) { await prompt(s, 'ch', 'chat', 'compliance', 1); await prompt(s, 'ch', 'chat', 'compliance', 1); }
    await prompt('ch-3', 'ch', 'chat', 'compliance', 1);
    // Replies come five minutes after the prompts, so the conversation's time is measured.
    const reply = (id: string, conversation: string, artifacts: number) =>
      sql.run(`INSERT INTO chat_assistant_meta (id, conversation_id, user_id, model, artifacts_count, generated_files_count, occurred_at)
               VALUES (?, ?, 'ch', 'claude-sonnet-5', ?, 0, ?)`, [id, conversation, artifacts, t + 300]);
    await reply('r1', 'ch-1', 1);
    await reply('r2', 'ch-2', 0);

    // ChatGPT only: three conversations of four prompts each, all Tier 3, with their measured time.
    for (const s of ['chatgpt:a', 'chatgpt:b', 'chatgpt:c']) {
      for (let i = 0; i < 4; i++) await prompt(s, 'gpt', 'cowork', s === 'chatgpt:a' ? 'chatgpt_work' : 'chatgpt_chat', 3);
      await sql.run(`INSERT INTO chatgpt_session_time (session_id, user_id, source, first_at, last_at, active_secs, human_minutes_likely, computed_at)
                     VALUES (?, 'gpt', 'chatgpt_chat', ?, ?, 120, 20, ?)`, [s, t, t, nowS]);
    }

    // Every session, with what each platform measured.
    const sessions = await readWorkSessions({ since: nowS - 30 * 86400, vendor: 'all' });
    const byId = new Map(sessions.map(s => [s.sessionId, s]));
    expect(sessions).toHaveLength(9);
    // Claude Chat's time is the gaps between its prompts and replies; it has no by-hand estimate.
    expect(byId.get('ch-1')).toMatchObject({ platform: 'claude_chat', produced: true, activeSecs: 300, humanMinutes: null, department: 'Finance' });
    expect(byId.get('ch-2')!.produced).toBe(false);
    // One prompt and no reply: nothing produced on record and no span to measure.
    expect(byId.get('ch-3')).toMatchObject({ produced: null, activeSecs: null });
    expect(byId.get('chatgpt:a')).toMatchObject({ platform: 'chatgpt', produced: null, activeSecs: 120, humanMinutes: 20 });
    expect(byId.get('cw-s1')).toMatchObject({ platform: 'claude_work', produced: true, activeSecs: 600, humanMinutes: 60 });

    // All: every platform.
    const all = await getCoworkCoachingFigures('all', nowS);
    const fin = all.teams.find(x => x.department === 'Finance')!;
    expect(fin.people).toBe(3);
    expect(fin.prompts).toBe(4 + 5 + 12);
    expect(fin.deepShare).toBeCloseTo(16 / 21, 6);
    // Nobody has hardly used it: the ChatGPT-only person had three conversations.
    expect(fin.hardlyUsed).toBe(0);
    // Produced: cw-s1 and ch-1 yes; cw-s2, cw-s3 and ch-2 no. ch-3 and ChatGPT are not measured.
    expect(fin.producedNothing).toEqual({ sessions: 3, measured: 5, share: 0.6 });
    // Time: the Cowork sessions with an estimate, and the three ChatGPT conversations.
    expect(fin.freed!.sessions).toBe(5);
    expect(fin.freed!.byHandHours).toBeCloseTo(150 / 60, 6);
    expect(fin.freed!.aiHours).toBeCloseTo(1260 / 3600, 6);
    expect(fin.champions.map(c => c.name)).toContain('gpt');
    expect(all.org.people).toBe(3);

    // Claude: Cowork and Claude Chat only.
    const claude = (await getCoworkCoachingFigures('claude', nowS)).teams.find(x => x.department === 'Finance')!;
    expect(claude.people).toBe(2);
    expect(claude.prompts).toBe(9);
    expect(claude.freed!.sessions).toBe(2);
    expect(claude.champions.map(c => c.name)).not.toContain('gpt');

    // ChatGPT: the ChatGPT person alone, whose output is not measured.
    const openai = (await getCoworkCoachingFigures('openai', nowS)).teams.find(x => x.department === 'Finance')!;
    expect(openai.people).toBe(1);
    expect(openai.prompts).toBe(12);
    expect(openai.hardlyUsed).toBe(0);
    expect(openai.freed!.sessions).toBe(3);
    expect(openai.producedNothing).toBeNull();
  } finally {
    await cleanup();
  }
}

describe('Work Pulse Team coaching across every platform (postgres)', () => {
  it('reads Claude Cowork, Claude Chat and ChatGPT, and follows the switch', async () => {
    await runSpec();
  }, 180_000);
});
