// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// My Pulse and Departments' period figures on Postgres (lib/pulse/my-period.ts): the quarter is
// the last 13 weeks to now, and "What you produced" counts Claude Cowork's saved files, what Claude
// Chat's replies made and the files ChatGPT's replies listed, following the vendor switch.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestSql } from './helpers/sql';
import { createTestDatabase } from './helpers/db';
import { weekStart } from '@/lib/pulse/period';

let sql: TestSql;
let cleanup: () => Promise<void>;
const DAY = 86400;
// Wednesday 12 November 2025, 15:30 UTC.
const NOW = Date.UTC(2025, 10, 12, 15, 30) / 1000;
const MONDAY = weekStart(NOW);

beforeAll(async () => {
  ({ sql, cleanup } = await createTestDatabase());
  const t = MONDAY - 2 * DAY; // last week
  await sql.run(`INSERT INTO users (id, email, display_name, first_seen_at, last_seen_at) VALUES ('me', 'me@example.com', 'Me', ?, ?)`, [t, t]);
  await sql.run(`INSERT INTO users (id, email, display_name, first_seen_at, last_seen_at) VALUES ('other', 'o@example.com', 'Other', ?, ?)`, [t, t]);
  const prompt = (id: string, session: string, user: string, surface: string, source: string, at: number, output: string | null = null) =>
    sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, content_full, output_name, occurred_at)
             VALUES (?, ?, ?, 'cowork_user_message', ?, ?, 'Do the work', ?, ?)`, [id, session, user, surface, source, output, at]);
  const judge = (id: string, user: string, tier: number) =>
    sql.run(`INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at)
             VALUES (?, ?, ?, 'analysis', 0.9, 'm', ?)`, [id, user, tier, NOW]);
  // Claude Cowork: a saved report last week, and a judged task this week.
  await prompt('cw-1', 'cw-s1', 'me', 'cowork', 'otel', t, 'board-note.docx');
  await judge('cw-1', 'me', 2);
  await prompt('cw-2', 'cw-s2', 'me', 'cowork', 'otel', MONDAY + DAY);
  await judge('cw-2', 'me', 2);
  // Claude Chat: a reply that made a spreadsheet.
  await prompt('ch-1', 'ch-s1', 'me', 'chat', 'compliance', t);
  await sql.run(`INSERT INTO chat_assistant_meta (id, conversation_id, user_id, artifacts_count, generated_files_count, output_names, occurred_at)
                 VALUES ('am-1', 'ch-s1', 'me', 0, 1, 'forecast.xlsx', ?)`, [t + 60]);
  // ChatGPT: a reply that listed a deck.
  await prompt('gw-1', 'chatgpt:w1', 'me', 'cowork', 'chatgpt_work', t);
  await sql.run(`INSERT INTO openai_replies (id, user_id, session_id, source, model, files_count, file_names, occurred_at)
                 VALUES ('chatgpt-reply:r1', 'me', 'chatgpt:w1', 'chatgpt_work', 'gpt-5.5', 1, 'pitch.pptx', ?)`, [t + 60]);
  // Someone else's reply: not counted.
  await sql.run(`INSERT INTO chat_assistant_meta (id, conversation_id, user_id, artifacts_count, generated_files_count, output_names, occurred_at)
                 VALUES ('am-2', 'ch-other', 'other', 1, 0, 'Their plan', ?)`, [t]);
}, 120_000);
afterAll(async () => cleanup());

const build = async (vendor: 'all' | 'claude' | 'openai', period: 'week' | 'quarter' = 'quarter') => {
  const { buildMyPeriod } = await import('@/lib/pulse/my-period');
  return buildMyPeriod({ userId: 'me', department: null, vendor, nowS: NOW, period, showHumanTime: false, humanTimeOn: false });
};

describe('buildMyPeriod', () => {
  it('reads the quarter as the last 13 weeks to now, so this week counts', async () => {
    const q = await build('all');
    expect(q.end).toBe(NOW);
    expect(q.start).toBe(NOW - 13 * 7 * DAY);
    expect(q.realWork.now).toBe(2);
    // The week still ends now, so this week's task counts there.
    const w = await build('all', 'week');
    expect(w.end).toBe(NOW);
    expect(w.realWork.now).toBe(2);
  });

  it('counts what every product produced, following the switch', async () => {
    const all = (await build('all')).produced;
    expect(all.files).toBe(3);
    expect(all.byKind).toEqual(expect.arrayContaining([
      { kind: 'Reports', files: 1 }, { kind: 'Spreadsheets', files: 1 }, { kind: 'Presentations', files: 1 },
    ]));
    expect(all.sessions).toBe(4);
    expect((await build('claude')).produced.files).toBe(2);
    expect((await build('openai')).produced.files).toBe(1);
  });

  it("sets a department's share beside the rest of the organisation's, not a scaled count", async () => {
    const t = MONDAY - 2 * DAY;
    for (const [id, tier] of [['o1', 2], ['o2', 1], ['o3', 1]] as const) {
      await sql.run(`INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)`, [id, `${id}@example.com`, id]);
      await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, occurred_at)
                     VALUES (?, ?, ?, 'cowork_user_message', 'cowork', 'otel', ?)`, [`m-${id}`, `s-${id}`, id, t]);
      await sql.run(`INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at)
                     VALUES (?, ?, ?, 'analysis', 0.9, 'm', ?)`, [`m-${id}`, id, tier, NOW]);
    }
    const { buildMyPeriod } = await import('@/lib/pulse/my-period');
    const dept = await buildMyPeriod({ userIds: ['me'], department: null, vendor: 'claude', nowS: NOW, period: 'quarter', showHumanTime: false, humanTimeOn: false });
    // The rest of the organisation: 1 of 3 judged tasks meaningful or frontier.
    expect(dept.realWork.orgShare).toBeCloseTo(1 / 3, 6);
    expect(dept.realWork.deptAverage).toBeNull();
    // A person's page keeps the per-person department average and has no organisation share.
    expect((await build('claude')).realWork.orgShare).toBeUndefined();
  });
});
