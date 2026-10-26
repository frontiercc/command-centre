// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  await sql.exec(`
    INSERT INTO users (id, email, display_name, department) VALUES ('u1', 'a@example.com', 'Alice', 'Engineering');
    INSERT INTO users (id, email, display_name, department) VALUES ('u2', 'b@example.org', 'Bob', 'Finance');
    INSERT INTO compliance_events (id, user_id, surface, event_type, content_preview, metadata, flagged, flag_reason, occurred_at, ingested_at)
      VALUES ('e1','u1','chat','chat_completion','hello',NULL,0,NULL,1000,1000);
    INSERT INTO compliance_events (id, user_id, surface, event_type, content_preview, metadata, flagged, flag_reason, occurred_at, ingested_at)
      VALUES ('e2','u2','chat','chat_completion','world',NULL,0,NULL,1001,1001);
  `);
});

afterAll(async () => {
  await cleanup();
});

describe('Department filter SQL logic', () => {
  it('filters compliance events by department via LEFT JOIN', async () => {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const dept = 'Engineering';
    conditions.push('u.department = ?');
    params.push(dept);
    const rows = await sql.all(`
      SELECT ce.* FROM compliance_events ce
      LEFT JOIN users u ON ce.user_id = u.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY ce.occurred_at DESC
    `, params);
    expect(rows).toHaveLength(1);
    expect((rows[0] as { id: string }).id).toBe('e1');
  });

  it('returns all events when no department filter', async () => {
    const rows = await sql.all(`
      SELECT ce.* FROM compliance_events ce
      LEFT JOIN users u ON ce.user_id = u.id
      ORDER BY ce.occurred_at DESC
    `);
    expect(rows).toHaveLength(2);
  });

  it('filters alerts by department via user join', async () => {
    await sql.exec(`
      INSERT INTO alerts (id, user_id, alert_type, severity, title, explanation, status, generated_at)
        VALUES ('a1','u1','pii','high','Test 1','desc','open',1000) ON CONFLICT DO NOTHING;
      INSERT INTO alerts (id, user_id, alert_type, severity, title, explanation, status, generated_at)
        VALUES ('a2','u2','pii','high','Test 2','desc','open',1001) ON CONFLICT DO NOTHING;
    `);
    const rows = await sql.all(`
      SELECT a.* FROM alerts a
      LEFT JOIN users u ON a.user_id = u.id
      WHERE u.department = ?
      ORDER BY a.generated_at DESC LIMIT 500
    `, ['Finance']);
    expect(rows).toHaveLength(1);
    expect((rows[0] as { id: string }).id).toBe('a2');
  });
});
