// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// buildSessionTaskTypeMap collapses a session's several classifications to one
// task type. It feeds BOTH the FinOps Model Efficiency activity axis and the
// session output rate breakdown, so the rule below governs what two shipped
// surfaces attribute work to.
//
// The rule: a label describing the MECHANISM a session
// used must never win the session away from a label describing the WORK.
// Most-frequent alone did exactly that — a long session tags connector_assisted
// on every tool call and drowns out the one message tagged analysis. Measured on
// a production deployment over 13 weeks: analysis appeared on 40 sessions and survived on 2,
// structured_report 16 -> 1, synthesis and capability_creation wiped out.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';
import { seedUserSql } from './helpers/seed';

let sql: TestSql;
let cleanup: () => Promise<void>;
let buildSessionTaskTypeMap: (client: unknown, ids: string[]) => Promise<Map<string, string>>;
let getTypedClient: () => Promise<unknown>;
let MECHANISM_TASK_TYPES: ReadonlySet<string>;

const NOW = 1_757_000_000;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const mod = await import('@/lib/finance/model-efficiency');
  buildSessionTaskTypeMap = mod.buildSessionTaskTypeMap as typeof buildSessionTaskTypeMap;
  MECHANISM_TASK_TYPES = mod.MECHANISM_TASK_TYPES;
  ({ getTypedClient } = await import('@/lib/db/client'));

  await seedUserSql(sql, 'user-1');
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec('DELETE FROM pulse_classifications');
  await sql.exec('DELETE FROM cowork_messages');
  await sql.exec('DELETE FROM cowork_sessions');
});

let seq = 0;
/** Tag a session with `[taskType, howManyMessages]` pairs, oldest first. */
async function session(id: string, tags: Array<[string, number]>) {
  await sql.run(
    'INSERT INTO cowork_sessions (id, conversation_id, user_id, started_at) VALUES (?, ?, ?, ?)',
    [id, `conv-${id}`, 'user-1', NOW],
  );
  let at = NOW;
  for (const [taskType, count] of tags) {
    for (let i = 0; i < count; i++) {
      at += 60;
      const msgId = `m-${++seq}`;
      await sql.run(
        `INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, source, occurred_at)
         VALUES (?, ?, ?, 'cowork_user_message', 'cowork', 'otel', ?)`,
        [msgId, id, 'user-1', at],
      );
      await sql.run(
        `INSERT INTO pulse_classifications
           (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at)
         VALUES (?, ?, 2, ?, 0.9, 'test', ?)`,
        [msgId, 'user-1', taskType, at],
      );
    }
  }
}

async function collapse(ids: string[]) {
  return buildSessionTaskTypeMap(await getTypedClient(), ids);
}

describe('MECHANISM_TASK_TYPES', () => {
  it('names the four connector/skill labels and nothing else', () => {
    expect([...MECHANISM_TASK_TYPES].sort()).toEqual([
      'connector_assisted', 'connector_orchestration', 'skill_assisted', 'skill_invocation',
    ]);
  });

  it('does not treat autonomous_workflow or multi_file_operation as mechanism', () => {
    expect(MECHANISM_TASK_TYPES.has('autonomous_workflow')).toBe(false);
    expect(MECHANISM_TASK_TYPES.has('multi_file_operation')).toBe(false);
  });
});

describe('buildSessionTaskTypeMap', () => {
  it('gives the session to the work, even when a mechanism label is far more frequent', async () => {
    // The a production deployment shape: one analysis prompt, twelve connector tool tags.
    await session('s1', [['analysis', 1], ['connector_assisted', 12]]);
    const m = await collapse(['s1']);
    expect(m.get('s1')).toBe('analysis');
  });

  it('still picks the most frequent among work-shaped labels', async () => {
    await session('s2', [['analysis', 2], ['structured_report', 5], ['skill_assisted', 20]]);
    const m = await collapse(['s2']);
    expect(m.get('s2')).toBe('structured_report');
  });

  it('falls back to a mechanism label when the session has nothing else', async () => {
    await session('s3', [['connector_orchestration', 3]]);
    const m = await collapse(['s3']);
    expect(m.get('s3')).toBe('connector_orchestration');
  });

  it('picks the most frequent mechanism label in that fallback', async () => {
    await session('s4', [['skill_assisted', 2], ['connector_assisted', 6]]);
    const m = await collapse(['s4']);
    expect(m.get('s4')).toBe('connector_assisted');
  });

  it('breaks a work-shaped tie on the most recent occurrence', async () => {
    // Equal counts; summarisation's messages are written later.
    await session('s5', [['analysis', 2], ['summarisation', 2]]);
    const m = await collapse(['s5']);
    expect(m.get('s5')).toBe('summarisation');
  });

  it('omits a session with no classifications at all', async () => {
    await session('s6', []);
    const m = await collapse(['s6']);
    expect(m.has('s6')).toBe(false);
  });

  it('returns an empty map for no session ids, without querying', async () => {
    const m = await collapse([]);
    expect(m.size).toBe(0);
  });
});
