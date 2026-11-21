// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// pulse_classifications carries copies of its prompt's time, session, person, surface and source
// (migration 0065), and Work Pulse reads those instead of joining cowork_messages. Database triggers
// must keep the copies equal to the message whoever writes either table.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;

const copies = (id: string) => sql.get<Record<string, unknown>>(
  `SELECT msg_occurred_at AS at, msg_session_id AS session, msg_user_id AS user, msg_surface AS surface, msg_source AS source
     FROM pulse_classifications WHERE cowork_message_id = ?`, [id]);

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
  await sql.run(`INSERT INTO users (id, email, display_name, source) VALUES ('u1', 'u1@test.local', 'U1', 'otel'), ('u2', 'u2@test.local', 'U2', 'otel')`);
  await sql.run(
    `INSERT INTO cowork_messages (id, session_id, user_id, message_type, occurred_at, ingested_at, surface, source)
     VALUES ('m1', 's1', 'u1', 'cowork_user_message', 1000, 1000, 'cowork', 'otel'),
            ('m2', 's2', 'u2', 'cowork_user_message', 2000, 2000, 'chat', 'chatgpt_chat')`);
});

afterAll(async () => cleanup());

describe('classification copies of prompt fields', () => {
  it('are filled when a classification is written without them', async () => {
    await sql.run(
      `INSERT INTO pulse_classifications (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classified_at)
       VALUES ('m1', 'u1', 2, 'analysis', 0.9, 'haiku', 1100), ('m2', 'u2', 1, 'drafting', 0.8, 'haiku', 2100)`);
    expect(await copies('m1')).toEqual({ at: 1000, session: 's1', user: 'u1', surface: 'cowork', source: 'otel' });
    expect(await copies('m2')).toEqual({ at: 2000, session: 's2', user: 'u2', surface: 'chat', source: 'chatgpt_chat' });
  });

  it('follow the message when its fields change, and only that message', async () => {
    await sql.run(`UPDATE cowork_messages SET occurred_at = 5000, session_id = 's9', source = 'agent' WHERE id = 'm1'`);
    expect(await copies('m1')).toEqual({ at: 5000, session: 's9', user: 'u1', surface: 'cowork', source: 'agent' });
    expect(await copies('m2')).toEqual({ at: 2000, session: 's2', user: 'u2', surface: 'chat', source: 'chatgpt_chat' });
  });

  it('ignore changes to other message fields', async () => {
    await sql.run(`UPDATE cowork_messages SET content_preview = 'x' WHERE id = 'm2'`);
    expect(await copies('m2')).toEqual({ at: 2000, session: 's2', user: 'u2', surface: 'chat', source: 'chatgpt_chat' });
  });

  it('are refilled when a classification is pointed at another message', async () => {
    await sql.run(`DELETE FROM pulse_classifications WHERE cowork_message_id = 'm2'`);
    await sql.run(`UPDATE pulse_classifications SET cowork_message_id = 'm2' WHERE cowork_message_id = 'm1'`);
    expect(await copies('m2')).toEqual({ at: 2000, session: 's2', user: 'u2', surface: 'chat', source: 'chatgpt_chat' });
  });
});
