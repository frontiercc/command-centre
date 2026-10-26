// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// DB-read tests for gatherDeptCorpora / gatherSessionFacts (Department Process
// Transformation). Same harness as test/process-suggestion-store.test.ts —
// real migrations via createTestDatabase(), no hand-DDL fixture.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
let corpus: typeof import('@/lib/usecases/process-corpus');

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
  corpus = await import('@/lib/usecases/process-corpus');
});
afterAll(async () => cleanup());
beforeEach(async () => {
  await sql.exec(`DELETE FROM pulse_classifications; DELETE FROM cowork_mcp_invocations;
           DELETE FROM cowork_skill_invocations; DELETE FROM cowork_session_stats;
           DELETE FROM cowork_sessions; DELETE FROM cowork_messages;
           DELETE FROM admin_users; DELETE FROM users;`);
});

async function seedUser(id: string, dept: string | null) {
  await sql.run(`INSERT INTO users (id, email, display_name, department) VALUES (?, ?, ?, ?)`, [id, `${id}@t.local`, id.toUpperCase(), dept]);
}
async function seedAdminUser(id: string, dept: string | null, linkedUserId: string) {
  await sql.run(`INSERT INTO admin_users (id, email, password_hash, department, linked_cowork_user_id)
              VALUES (?, ?, 'x', ?, ?)`, [id, `${id}@t.local`, dept, linkedUserId]);
}
async function seedCoworkSession(sessionId: string, userId: string, conversationId = sessionId) {
  await sql.run(`INSERT INTO cowork_sessions (id, conversation_id, user_id) VALUES (?, ?, ?)`, [sessionId, conversationId, userId]);
}
async function seedMessage(
  msgId: string, userId: string, sessionId: string, occurredAt: number,
  opts: { surface?: string; messageType?: string; contentFull?: string | null } = {},
) {
  const surface = opts.surface ?? 'cowork';
  const messageType = opts.messageType ?? 'cowork_user_message';
  const contentFull = opts.contentFull === undefined ? 'default prompt text' : opts.contentFull;
  await sql.run(`INSERT INTO cowork_messages
    (id, session_id, user_id, message_type, surface, content_full, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, [msgId, sessionId, userId, messageType, surface, contentFull, occurredAt]);
}

describe('gatherDeptCorpora', () => {
  it('groups by department via both resolution paths and excludes non-qualifying rows', async () => {
    // Direct users.department path.
    await seedUser('anna', 'Finance');
    await seedMessage('m-anna-1', 'anna', 's-anna-1', NOW - 2 * DAY);

    // admin_users.department via linked_cowork_user_id (users.department NULL).
    await seedUser('ben', null);
    await seedAdminUser('admin-ben', 'Sales', 'ben');
    await seedMessage('m-ben-1', 'ben', 's-ben-1', NOW - 2 * DAY);

    // Excluded: wrong surface.
    await seedUser('cara', 'Finance');
    await seedMessage('m-cara-1', 'cara', 's-cara-1', NOW - 2 * DAY, { surface: 'code' });

    // Excluded: null content_full (retention-stripped).
    await seedUser('dora', 'Finance');
    await seedMessage('m-dora-1', 'dora', 's-dora-1', NOW - 2 * DAY, { contentFull: null });

    // Excluded: blank content_full.
    await seedUser('elle', 'Finance');
    await seedMessage('m-elle-1', 'elle', 's-elle-1', NOW - 2 * DAY, { contentFull: '   ' });

    // Excluded: outside the window.
    await seedUser('finn', 'Finance');
    await seedMessage('m-finn-1', 'finn', 's-finn-1', NOW - 60 * DAY);

    // Excluded: no department at all.
    await seedUser('gus', null);
    await seedMessage('m-gus-1', 'gus', 's-gus-1', NOW - 2 * DAY);

    const corpora = await corpus.gatherDeptCorpora(NOW, 28);

    const depts = corpora.map(c => c.department).sort();
    expect(depts).toEqual(['Finance', 'Sales']);

    const finance = corpora.find(c => c.department === 'Finance')!;
    expect(finance.excerpts.map(e => e.userId)).toEqual(['anna']);

    const sales = corpora.find(c => c.department === 'Sales')!;
    expect(sales.excerpts.map(e => e.userId)).toEqual(['ben']);
  });

  it('redacts PII in excerpt text', async () => {
    await seedUser('anna', 'Finance');
    await seedMessage('m-anna-1', 'anna', 's-anna-1', NOW - 2 * DAY, {
      contentFull: 'Please email test@example.com the report',
    });

    const corpora = await corpus.gatherDeptCorpora(NOW, 28);
    const finance = corpora.find(c => c.department === 'Finance')!;
    expect(finance.excerpts).toHaveLength(1);
    expect(finance.excerpts[0].text).not.toContain('test@example.com');
  });

  it('truncates excerpt text to EXCERPT_CHARS (600) before redaction', async () => {
    await seedUser('anna', 'Finance');
    const long = 'x'.repeat(1000);
    await seedMessage('m-anna-1', 'anna', 's-anna-1', NOW - 2 * DAY, { contentFull: long });

    const corpora = await corpus.gatherDeptCorpora(NOW, 28);
    const finance = corpora.find(c => c.department === 'Finance')!;
    expect(finance.excerpts[0].text.length).toBeLessThanOrEqual(corpus.EXCERPT_CHARS);
  });

  it('caps at 10 excerpts per user, keeping the newest', async () => {
    await seedUser('anna', 'Finance');
    // Seed 12 messages, newest first in time; expect the 10 most recent to survive.
    for (let i = 0; i < 12; i++) {
      await seedMessage(`m-anna-${i}`, 'anna', `s-anna-${i}`, NOW - 2 * DAY - i * 60, { contentFull: `msg ${i}` });
    }

    const corpora = await corpus.gatherDeptCorpora(NOW, 28);
    const finance = corpora.find(c => c.department === 'Finance')!;
    expect(finance.excerpts).toHaveLength(10);
    // The 2 oldest (i=10, i=11) must have been dropped by the per-user cap.
    const texts = finance.excerpts.map(e => e.text);
    expect(texts).not.toContain('msg 10');
    expect(texts).not.toContain('msg 11');
  });

  it('assigns indices 0..n-1 in oldest-first order', async () => {
    await seedUser('anna', 'Finance');
    await seedMessage('m-anna-old', 'anna', 's-anna-old', NOW - 10 * DAY, { contentFull: 'oldest' });
    await seedMessage('m-anna-mid', 'anna', 's-anna-mid', NOW - 5 * DAY, { contentFull: 'middle' });
    await seedMessage('m-anna-new', 'anna', 's-anna-new', NOW - 1 * DAY, { contentFull: 'newest' });

    const corpora = await corpus.gatherDeptCorpora(NOW, 28);
    const finance = corpora.find(c => c.department === 'Finance')!;
    expect(finance.excerpts.map(e => e.index)).toEqual([0, 1, 2]);
    expect(finance.excerpts.map(e => e.text)).toEqual(['oldest', 'middle', 'newest']);
  });

  it('caps at MAX_EXCERPTS_PER_DEPT excerpts per department across multiple users', async () => {
    // 13 users x 10 messages each = 130 qualifying rows for one department;
    // per-user cap (10) never binds, so the per-dept cap (120) must trim 10 rows.
    for (let u = 0; u < 13; u++) {
      const userId = `user${u}`;
      await seedUser(userId, 'Finance');
      for (let i = 0; i < 10; i++) {
        await seedMessage(`m-${userId}-${i}`, userId, `s-${userId}-${i}`, NOW - 2 * DAY - (u * 10 + i) * 60, { contentFull: `${userId} msg ${i}` });
      }
    }

    const corpora = await corpus.gatherDeptCorpora(NOW, 28);
    const finance = corpora.find(c => c.department === 'Finance')!;
    expect(finance.excerpts).toHaveLength(corpus.MAX_EXCERPTS_PER_DEPT);
  });

  it('excludes users whose admin_users.department is blank (empty string)', async () => {
    // User with users.department = NULL and admin_users.department = ''.
    // The NULLIF(TRIM(au.department), '') must treat '' as NULL, excluding the user.
    await seedUser('hank', null);
    await seedAdminUser('admin-hank', '', 'hank');
    await seedMessage('m-hank-1', 'hank', 's-hank-1', NOW - 2 * DAY);

    // Sanity check: a user with valid admin_users.department IS included.
    await seedUser('iris', null);
    await seedAdminUser('admin-iris', 'Operations', 'iris');
    await seedMessage('m-iris-1', 'iris', 's-iris-1', NOW - 2 * DAY);

    const corpora = await corpus.gatherDeptCorpora(NOW, 28);

    const depts = corpora.map(c => c.department).sort();
    expect(depts).toEqual(['Operations']);
    expect(corpora.some(c => c.department === '')).toBe(false);

    const ops = corpora.find(c => c.department === 'Operations')!;
    expect(ops.excerpts.map(e => e.userId)).toEqual(['iris']);
  });
});

describe('gatherSessionFacts', () => {
  it('returns skills/connectors union, sums active_secs (null-aware), and collects tiers', async () => {
    await seedUser('anna', 'Finance');
    await seedMessage('m-anna-1', 'anna', 's1', NOW - 2 * DAY);
    await seedMessage('m-anna-2', 'anna', 's2', NOW - 2 * DAY);

    await sql.run(`INSERT INTO cowork_skill_invocations (id, user_id, session_id, skill_name, occurred_at)
                VALUES (?, 'anna', 's1', 'docx', ?)`, ['sk1', NOW - 2 * DAY]);
    await sql.run(`INSERT INTO cowork_skill_invocations (id, user_id, session_id, skill_name, occurred_at)
                VALUES (?, 'anna', 's2', 'xlsx', ?)`, ['sk2', NOW - 2 * DAY]);
    await sql.run(`INSERT INTO cowork_mcp_invocations (id, user_id, session_id, mcp_server, mcp_tool, occurred_at)
                VALUES (?, 'anna', 's1', 'salesforce', 't', ?)`, ['mc1', NOW - 2 * DAY]);

    await seedCoworkSession('s1', 'anna');
    await seedCoworkSession('s2', 'anna');
    await sql.run(`INSERT INTO cowork_session_stats (session_id, user_id, computed_at, active_secs)
                VALUES ('s1', 'anna', ?, 100)`, [NOW]);
    await sql.run(`INSERT INTO cowork_session_stats (session_id, user_id, computed_at, active_secs)
                VALUES ('s2', 'anna', ?, NULL)`, [NOW]);

    await sql.run(`INSERT INTO pulse_classifications
      (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classifier_status, classified_at)
      VALUES ('m-anna-1', 'anna', 2, 'structured_report', 0.9, 'test', 'classified', ?)`, [NOW]);
    await sql.run(`INSERT INTO pulse_classifications
      (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classifier_status, classified_at)
      VALUES ('m-anna-2', 'anna', 3, 'structured_report', 0.9, 'test', 'classified', ?)`, [NOW]);

    const facts = await corpus.gatherSessionFacts(['s1', 's2']);
    expect(facts.skills).toEqual(['docx', 'xlsx']);
    expect(facts.connectors).toEqual(['salesforce']);
    expect(facts.activeSecs).toBe(100); // s2's null row contributes nothing, not treated as 0-and-summed-anyway
    expect(facts.tiers.sort()).toEqual([2, 3]);
  });

  it('returns activeSecs null when every matched session-stats row is null', async () => {
    await seedUser('anna', 'Finance');
    await seedMessage('m-anna-1', 'anna', 's1', NOW - 2 * DAY);
    await seedCoworkSession('s1', 'anna');
    await sql.run(`INSERT INTO cowork_session_stats (session_id, user_id, computed_at, active_secs)
                VALUES ('s1', 'anna', ?, NULL)`, [NOW]);

    const facts = await corpus.gatherSessionFacts(['s1']);
    expect(facts.activeSecs).toBeNull();
  });

  it('returns empty facts for an empty session id list', async () => {
    const facts = await corpus.gatherSessionFacts([]);
    expect(facts).toEqual({ skills: [], connectors: [], activeSecs: null, tiers: [] });
  });
});

describe('loadSessionClues (files uploaded and made, connector actions)', () => {
  it('reads what each session took in and handed out, cleaned and capped, and leaves out sessions with none', async () => {
    await seedUser('anna', 'Finance');
    await seedCoworkSession('s1', 'anna');
    await seedCoworkSession('s2', 'anna');
    await sql.run(`UPDATE cowork_sessions SET files_uploaded = ? WHERE id = 's1'`, [JSON.stringify(['timesheet_export.csv', '/Users/anna/Desktop/allocation.xlsx'])]);
    await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, occurred_at, output_name)
      VALUES ('o1', 's1', 'anna', 'cowork_tool_metadata', 'cowork', ?, 'timesheet-chase-tracker.html'),
             ('o2', 's1', 'anna', 'cowork_tool_metadata', 'cowork', ?, 'chase list for anna@example.com.md')`, [NOW, NOW]);
    await sql.run(`INSERT INTO cowork_mcp_invocations (id, user_id, session_id, mcp_server, mcp_tool, occurred_at, success)
      VALUES ('i1', 'anna', 's1', 'gmail', 'create_draft', ?, 1), ('i2', 'anna', 's1', 'gmail', 'send', ?, 0), ('i3', 'anna', 's1', 'workspace', 'bash', ?, 1)`, [NOW, NOW, NOW]);

    const clues = await corpus.loadSessionClues(['s1', 's2']);
    expect(clues.has('s2')).toBe(false);
    const c = clues.get('s1')!;
    expect(c.uploaded[0]).toBe('timesheet_export.csv');
    expect(c.uploaded[1]).toBe('allocation.xlsx'); // the folders are dropped, the file name kept
    expect(c.made).toContain('timesheet-chase-tracker.html');
    expect(c.made.join(' ')).not.toContain('anna@example.com'); // PII masked
    expect(c.actions).toEqual(['gmail create_draft']); // a failed action and Claude's own tools are not clues
  });

  it('gatherDeptCorpora attaches each sampled session\'s clues', async () => {
    await seedUser('anna', 'Finance');
    await seedMessage('m1', 'anna', 's1', NOW - 2 * DAY, { contentFull: 'chase the missing timesheets' });
    await seedCoworkSession('s1', 'anna');
    await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, occurred_at, output_name)
      VALUES ('o1', 's1', 'anna', 'cowork_tool_metadata', 'cowork', ?, 'chase-list.md')`, [NOW - 2 * DAY]);
    const [fin] = await corpus.gatherDeptCorpora(NOW, 28);
    expect(fin.clues?.s1?.made).toEqual(['chase-list.md']);
  });
});
