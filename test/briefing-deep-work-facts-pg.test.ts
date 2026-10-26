// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Deep-work facts for the briefings: measured kinds and counts,
// tool labels never counted as a kind of work, no names anywhere.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import { seedUserSql } from './helpers/seed';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;
const NOW = Math.floor(Date.UTC(2026, 8, 26, 12) / 1000);
const DAY = 86400;
let n = 0;

async function work(user: string, session: string, taskType: string, tier: number, at: number, capability?: 'candidate' | 'confirmed') {
  const id = `dw-m${++n}`;
  await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, content_preview, occurred_at)
    VALUES (?, ?, ?, 'cowork_user_message', 'cowork', 'x', ?)`, [id, session, user, at]);
  await sql.run(`INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at)
    VALUES (?, ?, ?, ?, 0.9, 'haiku', ?)`, [id, user, tier, taskType, at]);
  if (capability) {
    await sql.run(`INSERT INTO pulse_events (user_id, event_type, status, title, cowork_message_id, tier, detected_at)
      VALUES (?, 'capability_creation', ?, 'New capability', ?, ?, ?)`, [user, capability, id, tier, at]);
  }
}

beforeAll(async () => {
  ({ sql, cleanup } = await createTestDatabase());
  for (const u of ['alice', 'bob', 'carol']) await seedUserSql(sql, u);
  await sql.run(`UPDATE users SET display_name = 'Alice Example' WHERE id = 'alice'`);
  await work('alice', 's1', 'analysis', 3, NOW - 2 * DAY);
  await work('alice', 's1', 'connector_orchestration', 3, NOW - 2 * DAY);
  await work('alice', 's2', 'analysis', 3, NOW - 3 * DAY);
  await work('bob', 's3', 'analysis', 3, NOW - 4 * DAY);
  await work('bob', 's4', 'structured_report', 3, NOW - 5 * DAY, 'candidate');
  await work('carol', 's5', 'skill_invocation', 3, NOW - 6 * DAY); // tool label only
  await work('carol', 's6', 'drafting', 1, NOW - 1 * DAY);
  await work('carol', 's7', 'analysis', 3, NOW - 40 * DAY, 'confirmed'); // outside the window
});
afterAll(async () => cleanup());

describe('buildDeepWorkSummary (postgres)', () => {
  it('counts people and sessions, ranks named kinds, and never counts tool labels as work', async () => {
    const { buildDeepWorkSummary } = await import('@/lib/pulse/briefings/deep-work-facts');
    const s = await buildDeepWorkSummary(null, NOW - 30 * DAY, NOW);
    expect(s.tier3People).toBe(3);
    expect(s.tier3Sessions).toBe(5);
    expect(s.topKinds).toEqual([
      { kind: 'analysis', sessions: 3, people: 2 },
      { kind: 'structured_report', sessions: 1, people: 1 },
    ]);
    expect(s.newCapabilities).toEqual([{ kind: 'structured_report', count: 1, confirmed: 0 }]);
    expect(s.newCapabilitiesConfirmed).toBe(0);
    expect(s.pendingCapabilities).toBe(1);
  });

  it('scopes to a group of people', async () => {
    const { buildDeepWorkSummary } = await import('@/lib/pulse/briefings/deep-work-facts');
    const s = await buildDeepWorkSummary(['alice'], NOW - 30 * DAY, NOW);
    expect(s).toMatchObject({ tier3People: 1, tier3Sessions: 2, pendingCapabilities: 0 });
    expect(await buildDeepWorkSummary([], NOW - 30 * DAY, NOW)).toMatchObject({ tier3People: 0, topKinds: [] });
  });

  it('prompt lines carry no names', async () => {
    const { buildDeepWorkSummary, deepWorkLines } = await import('@/lib/pulse/briefings/deep-work-facts');
    const lines = deepWorkLines(await buildDeepWorkSummary(null, NOW - 30 * DAY, NOW));
    expect(lines[0]).toBe('People doing Tier 3 work: 3 (5 sessions)');
    expect(lines.join('\n')).toContain('analysis (3 sessions, 2 people)');
    expect(lines.join('\n')).toContain('Capabilities awaiting review: 1');
    expect(lines.join('\n')).toContain('of which 0 confirmed by a person so far. By kind of work: structured report (1 unreviewed)');
    expect(lines.join('\n')).not.toMatch(/Alice|alice|bob|carol/);
  });

  it('says so plainly when there is no deep work', async () => {
    const { deepWorkLines } = await import('@/lib/pulse/briefings/deep-work-facts');
    expect(deepWorkLines({ tier3People: 0, tier3Sessions: 0, topKinds: [], newCapabilities: [], newCapabilitiesConfirmed: 0, pendingCapabilities: 0 }))
      .toEqual(['No Tier 3 (autonomous, high-consequence) work in this period.', 'New capabilities detected: none']);
  });
});
