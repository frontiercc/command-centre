// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The session-description job on Postgres, with the model
// mocked: only frontier-eligible sessions are described, prompts are scrubbed
// before they are sent, failures are retried up to the cap, the switch stops
// both writing and reading, and retention deletes a description with its prompts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import { seedUserSql } from './helpers/seed';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
const NOW = Math.floor(Date.UTC(2026, 8, 26, 12) / 1000);
const DAY = 86400;

async function prompt(id: string, session: string, text: string, tier: number, at: number) {
  await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, content_preview, content_full, occurred_at)
    VALUES (?, ?, 'u1', 'cowork_user_message', 'cowork', ?, ?, ?)`, [id, session, text.slice(0, 50), text, at]);
  await sql.run(`INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at)
    VALUES (?, 'u1', ?, 'analysis', 0.9, 'haiku', ?)`, [id, tier, at]);
}

beforeAll(async () => {
  ({ sql, cleanup } = await createTestDatabase());
  await seedUserSql(sql, 'u1');
  // s-t3: Tier 3 two days ago, contains an email that must never reach the model.
  await prompt('m1', 's-t3', 'Compare the Q3 pipeline with the forecast and email jane.doe@example.com', 3, NOW - 2 * DAY);
  // s-t1: Tier 1 only — not eligible.
  await prompt('m2', 's-t1', 'Fix the typo in this sentence', 1, NOW - 2 * DAY);
  // s-bad: Tier 3, the model will keep failing validation.
  await prompt('m3', 's-bad', 'Draft the board summary', 3, NOW - 3 * DAY);
});
afterAll(async () => cleanup());

describe('runSessionDescriptionJob (postgres)', () => {
  it('describes eligible sessions only, from scrubbed prompts', async () => {
    const { runSessionDescriptionJob, readDescriptions } = await import('@/lib/pulse/session-descriptions');
    const sent: string[] = [];
    const r = await runSessionDescriptionJob(NOW, {
      callModel: async (p) => {
        sent.push(p);
        return p.includes('board summary')
          ? { text: 'Drafted 12 board summaries. And more.', model: 'mock' } // invented number + two sentences
          : { text: 'Compared the Q3 pipeline with the forecast for leadership.', model: 'mock' };
      },
    });
    // s-bad: rejected, repaired once, rejected again (same reply) -> one failure with its reason.
    expect(r).toEqual({ written: 1, failed: 1, skipped: false, reasons: { multiple_sentences: 1 } });
    expect(sent).toHaveLength(3);
    expect(sent.filter(p => p.includes('Your previous reply was not accepted'))).toHaveLength(1);
    expect(sent.join('\n')).not.toContain('jane.doe@example.com');
    const d = await readDescriptions(['s-t3', 's-t1', 's-bad']);
    expect([...d.keys()]).toEqual(['s-t3']);
  });

  it('a model-call error stops the run and counts no attempt', async () => {
    const { runSessionDescriptionJob } = await import('@/lib/pulse/session-descriptions');
    await prompt('m4', 's-new', 'Summarise the tender pack for the bid meeting', 3, NOW - DAY);
    const before = await sql.get<{ n: number }>(`SELECT count(*) AS n FROM cowork_session_descriptions`);
    const r = await runSessionDescriptionJob(NOW, { callModel: async () => { throw new Error('429 rate limited'); } });
    expect(r.apiError).toContain('429');
    const after = await sql.get<{ n: number }>(`SELECT count(*) AS n FROM cowork_session_descriptions`);
    expect(after!.n).toBe(before!.n);
    await sql.run(`DELETE FROM pulse_classifications WHERE cowork_message_id = 'm4'`);
    await sql.run(`DELETE FROM cowork_messages WHERE id = 'm4'`);
  });

  it('retries a failed session up to the attempt cap, then leaves it', async () => {
    const { runSessionDescriptionJob, MAX_ATTEMPTS } = await import('@/lib/pulse/session-descriptions');
    let calls = 0;
    const bad = async () => { calls++; return { text: 'Two. Sentences.', model: 'mock' }; };
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) await runSessionDescriptionJob(NOW, { callModel: bad });
    // s-bad already had 1 attempt; it gets MAX_ATTEMPTS - 1 more runs, each a first call
    // plus one repair call. s-t3 is never re-described.
    expect(calls).toBe(2 * (MAX_ATTEMPTS - 1));
    const row = await sql.get<{ attempts: number }>(`SELECT attempts FROM cowork_session_descriptions WHERE session_id = 's-bad'`);
    expect(row!.attempts).toBe(MAX_ATTEMPTS);
  });

  it('a repair call that fixes the reply is accepted, and names the broken rule', async () => {
    const { runSessionDescriptionJob, readDescriptions } = await import('@/lib/pulse/session-descriptions');
    await prompt('m5', 's-fix', 'Prepare the renewal pack for the client review', 3, NOW - DAY);
    const sent: string[] = [];
    const r = await runSessionDescriptionJob(NOW, {
      callModel: async (p) => {
        sent.push(p);
        return p.includes('Your previous reply was not accepted')
          ? { text: 'Prepared the renewal pack for the client review.', model: 'mock' }
          : { text: 'Prepared the renewal pack. Sent it to the client.', model: 'mock' };
      },
    });
    expect(r).toEqual({ written: 1, failed: 0, skipped: false });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('more than one sentence');
    expect((await readDescriptions(['s-fix'])).get('s-fix')).toBe('Prepared the renewal pack for the client review.');
    const row = await sql.get<{ attempts: number }>(`SELECT attempts FROM cowork_session_descriptions WHERE session_id = 's-fix'`);
    expect(row!.attempts).toBe(1);
  });

  it('migration 0029 gives missing descriptions a fresh set of attempts, and leaves written ones', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const file = path.join(process.cwd(), 'lib/db/migrations-pg/0029_retry_missing_session_descriptions.sql');
    const stmt = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => !l.startsWith('--')).join(' ').trim();
    await sql.run(stmt, []);
    const bad = await sql.get<{ attempts: number }>(`SELECT attempts FROM cowork_session_descriptions WHERE session_id = 's-bad'`);
    const good = await sql.get<{ attempts: number }>(`SELECT attempts FROM cowork_session_descriptions WHERE session_id = 's-t3'`);
    expect(bad!.attempts).toBe(0);
    expect(good!.attempts).toBe(1);
  });

  it('the switch stops writing and hides existing descriptions', async () => {
    const { runSessionDescriptionJob, readDescriptions } = await import('@/lib/pulse/session-descriptions');
    const { setConfigValue } = await import('@/lib/config');
    await setConfigValue('pulseSessionDescriptionsEnabled', 'false');
    const r = await runSessionDescriptionJob(NOW, { callModel: async () => { throw new Error('must not be called'); } });
    expect(r.skipped).toBe(true);
    expect((await readDescriptions(['s-t3'])).size).toBe(0);
    await setConfigValue('pulseSessionDescriptionsEnabled', 'true');
    expect((await readDescriptions(['s-t3'])).size).toBe(1);
  });

  it('retention deletes descriptions and output names with the prompts', async () => {
    const { runRetentionCleanup } = await import('@/lib/retention/cleanup');
    const { setConfigValue } = await import('@/lib/config');
    // Retention measures age from the real clock, so these rows are dated from
    // it too; dating them from the fixed NOW made the test fail once NOW was
    // more than a month in the past.
    const now = Math.floor(Date.now() / 1000);
    await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, content_preview, output_name, occurred_at)
      VALUES ('t-old', 's-old', 'u1', 'cowork_tool_metadata', 'cowork', 'Write', 'old-report.xlsx', ?),
             ('t-new', 's-t3', 'u1', 'cowork_tool_metadata', 'cowork', 'Write', 'new-report.xlsx', ?)`, [now - 40 * DAY, now - 2 * DAY]);
    await sql.run(`INSERT INTO cowork_session_descriptions (session_id, user_id, description, attempts, occurred_at, generated_at)
      VALUES ('s-old', 'u1', 'An old description.', 1, ?, ?),
             ('s-recent', 'u1', 'A recent description.', 1, ?, ?)`, [now - 40 * DAY, now - 39 * DAY, now - 2 * DAY, now - 1 * DAY]);
    await setConfigValue('retentionMode', 'strip');
    await setConfigValue('retentionCoworkDays', '30');
    await runRetentionCleanup();
    const names = await sql.all<{ id: string; output_name: string | null }>(`SELECT id, output_name FROM cowork_messages WHERE id IN ('t-old','t-new') ORDER BY id`);
    expect(names).toEqual([{ id: 't-new', output_name: 'new-report.xlsx' }, { id: 't-old', output_name: null }]);
    const descs = await sql.all<{ session_id: string }>(`SELECT session_id FROM cowork_session_descriptions ORDER BY session_id`);
    expect(descs.map(d => d.session_id)).not.toContain('s-old');
    expect(descs.map(d => d.session_id)).toContain('s-recent');
  });
});
