// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

vi.mock('@/lib/config', () => ({
  getConfigValue: async (key: string) => (key === 'anthropicAiApiKey' ? 'test-key' : ''),
}));

const mockCreate = vi.fn().mockResolvedValue({
  content: [{
    type: 'text',
    text: JSON.stringify({
      paragraphs: ['Para one.', 'Para two.', 'Para three.'],
      strength: 'Strong Tier 3 work',
      risk_note: 'Single owner risk',
      recommendation: 'Cross-train on analytics',
    }),
  }],
});

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));

let sql: TestSql;
let cleanup: () => Promise<void>;
let generateDeptBriefing: typeof import('@/lib/pulse/briefings/dept').generateDeptBriefing;

const NOW = Math.floor(Date.now() / 1000);
const PERIOD_START = NOW - 30 * 24 * 3600;
const PERIOD_END = NOW;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const dept = await import('@/lib/pulse/briefings/dept');
  generateDeptBriefing = dept.generateDeptBriefing;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  mockCreate.mockClear();
  await sql.exec(`DELETE FROM pulse_briefings;`);
  await sql.exec(`DELETE FROM pulse_events;`);
  await sql.exec(`DELETE FROM pulse_classifications;`);
  await sql.exec(`DELETE FROM pulse_metrics;`);
  await sql.exec(`DELETE FROM cowork_messages;`);
  await sql.exec(`DELETE FROM users;`);
});

async function seedUser(id: string, department: string | null) {
  await sql.run(
    `INSERT INTO users (id, email, display_name, department) VALUES (?, ?, ?, ?)`,
    [id, `${id}@example.com`, id, department],
  );
}

async function seedCoworkMessage(id: string, userId: string, occurredAt: number) {
  await sql.run(
    `INSERT INTO cowork_messages (id, session_id, user_id, message_type, occurred_at)
     VALUES (?, ?, ?, 'cowork_user_message', ?)`,
    [id, `session-${id}`, userId, occurredAt],
  );
}

async function seedClassification(opts: {
  id: string; coworkMessageId: string; userId: string; tier: number; taskType: string; classifiedAt: number;
}) {
  await sql.run(
    `INSERT INTO pulse_classifications
       (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at)
     VALUES (?, ?, ?, ?, 0.9, 'claude-haiku-4-5', ?)`,
    [opts.coworkMessageId, opts.userId, opts.tier, opts.taskType, opts.classifiedAt],
  );
}

describe('generateDeptBriefing', () => {
  it('returns joined paragraph text', async () => {
    await seedUser('u1', 'Engineering');
    await seedCoworkMessage('m1', 'u1', PERIOD_START + 1000);
    await seedClassification({ id: 'c1', coworkMessageId: 'm1', userId: 'u1', tier: 2, taskType: 'analytics', classifiedAt: PERIOD_START + 1000 });

    const result = await generateDeptBriefing('Engineering', PERIOD_START, PERIOD_END, 'claude-haiku-4-5-20251001');
    expect(result).toContain('Para one.');
    expect(result).toContain('Para three.');
  });

  it('persists to pulse_briefings with scope_type=function', async () => {
    await seedUser('u1', 'Engineering');
    await seedCoworkMessage('m1', 'u1', PERIOD_START + 1000);
    await seedClassification({ id: 'c1', coworkMessageId: 'm1', userId: 'u1', tier: 2, taskType: 'analytics', classifiedAt: PERIOD_START + 1000 });

    await generateDeptBriefing('Engineering', PERIOD_START, PERIOD_END, 'claude-haiku-4-5-20251001');

    const row = (await sql.get<{ scope_type: string; scope_id: string }>(
      `SELECT scope_type, scope_id FROM pulse_briefings ORDER BY id DESC LIMIT 1`,
    ))!;
    expect(row.scope_type).toBe('function');
    expect(row.scope_id).toBe('Engineering');
  });

  it('throws when the department has no users', async () => {
    await expect(
      generateDeptBriefing('Nonexistent', PERIOD_START, PERIOD_END, 'claude-haiku-4-5-20251001')
    ).rejects.toThrow('No users found in department: Nonexistent');
  });

  it('computes tier breakdown and concentration risk across department members', async () => {
    await seedUser('u1', 'Engineering');
    await seedUser('u2', 'Engineering');

    // u1 is the SOLE tier-3 user across 3 distinct task types -> concentration risk.
    for (const [i, taskType] of ['reporting', 'forecasting', 'modelling'].entries()) {
      const msgId = `m-t3-${i}`;
      await seedCoworkMessage(msgId, 'u1', PERIOD_START + 1000 + i);
      await seedClassification({ id: `c-t3-${i}`, coworkMessageId: msgId, userId: 'u1', tier: 3, taskType, classifiedAt: PERIOD_START + 1000 + i });
    }

    // u2 does tier-1 work.
    await seedCoworkMessage('m-t1', 'u2', PERIOD_START + 2000);
    await seedClassification({ id: 'c-t1', coworkMessageId: 'm-t1', userId: 'u2', tier: 1, taskType: 'basic_drafting', classifiedAt: PERIOD_START + 2000 });

    await generateDeptBriefing('Engineering', PERIOD_START, PERIOD_END, 'claude-haiku-4-5-20251001');

    // Assert on the actual prompt handed to the (mocked) Anthropic call: u1
    // did tier-3 work alone across 3 distinct task types this period, so the
    // concentration-risk count must be 1 (one user meets the >=3 threshold).
    const userMessage = mockCreate.mock.calls[0][0].messages[0].content as string;
    expect(userMessage).toContain('Users with concentration risk: 1');
    expect(userMessage).toContain('Active users: 2');
  });
});
