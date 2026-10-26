// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';
import { seedUserSql } from './helpers/seed';

let sql: TestSql;
let cleanup: () => Promise<void>;
let computeTeamOrsDetail: typeof import('@/lib/pulse/metrics/ors').computeTeamOrsDetail;
let computeTeamOrs: typeof import('@/lib/pulse/metrics/ors').computeTeamOrs;

const NOW = Math.floor(Date.now() / 1000);

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const ors = await import('@/lib/pulse/metrics/ors');
  computeTeamOrsDetail = ors.computeTeamOrsDetail;
  computeTeamOrs = ors.computeTeamOrs;

  await seedUserSql(sql, 'user-1');
  await seedUserSql(sql, 'user-2');
  await sql.run(`UPDATE users SET team_id = 'team-1' WHERE id IN ('user-1', 'user-2')`);
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`DELETE FROM pulse_classifications;
           DELETE FROM cowork_messages;
           DELETE FROM cowork_mcp_invocations;
           DELETE FROM cowork_skill_invocations;`);
});

async function seedMessage(id: string, userId: string, occurredAt: number) {
  await sql.run(
    `INSERT INTO cowork_messages
       (id, session_id, user_id, message_type, role, content_preview, occurred_at, ingested_at)
     VALUES (?, ?, ?, 'cowork_user_message', 'user', 'do the thing', ?, ?)`,
    [id, `session-${id}`, userId, occurredAt, occurredAt],
  );
}

async function seedClassification(id: number, messageId: string, userId: string, tier: number, classifiedAt: number) {
  await sql.run(
    `INSERT INTO pulse_classifications
       (id, cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classifier_status, classified_at)
     VALUES (?, ?, ?, ?, 'general', 0.9, 'test-model', 'classified', ?)`,
    [id, messageId, userId, tier, classifiedAt],
  );
}

describe('computeTeamOrsDetail — refactor safety', () => {
  it('returns non-null ors equal to the weighted composition of its own components, matching computeTeamOrs', async () => {
    // Both users active with T2 work in the last 30 days, sharing one skill.
    await seedMessage('msg-1', 'user-1', NOW);
    await seedMessage('msg-2', 'user-2', NOW);
    await seedClassification(1, 'msg-1', 'user-1', 2, NOW);
    await seedClassification(2, 'msg-2', 'user-2', 2, NOW);

    await sql.run(
      `INSERT INTO cowork_skill_invocations (id, user_id, session_id, skill_name, occurred_at)
       VALUES ('inv-1', 'user-1', 'session-msg-1', 'shared-skill', ?)`,
      [NOW],
    );
    await sql.run(
      `INSERT INTO cowork_skill_invocations (id, user_id, session_id, skill_name, occurred_at)
       VALUES ('inv-2', 'user-2', 'session-msg-2', 'shared-skill', ?)`,
      [NOW],
    );

    const detail = await computeTeamOrsDetail('team-1');

    expect(detail).not.toBeNull();
    expect(detail!.ors).not.toBeNull();
    expect(detail!.breadth).not.toBeNull();
    expect(detail!.propagation).not.toBeNull();

    // Weighted composition of the returned components must equal the returned ors
    // (base weights: breadth 0.3, connectorOverlap 0.4, skillPropagation 0.3;
    // proportionally reweighted when a component is null).
    const components: Array<{ value: number; weight: number }> = [
      { value: detail!.breadth as number, weight: 0.3 },
    ];
    if (detail!.overlap !== null) components.push({ value: detail!.overlap, weight: 0.4 });
    if (detail!.propagation !== null) components.push({ value: detail!.propagation, weight: 0.3 });
    const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
    const expectedOrs = components.reduce((sum, c) => sum + (c.value * c.weight) / totalWeight, 0);

    expect(detail!.ors).toBeCloseTo(expectedOrs, 10);

    // Refactor safety: the legacy wrapper must return the identical number.
    const legacy = await computeTeamOrs('team-1');
    expect(legacy).toBe(detail!.ors);
  });

  it('returns null when fewer than 2 active participants', async () => {
    await seedMessage('msg-1', 'user-1', NOW);
    await seedClassification(1, 'msg-1', 'user-1', 2, NOW);

    expect(await computeTeamOrsDetail('team-1')).toBeNull();
    expect(await computeTeamOrs('team-1')).toBeNull();
  });
});
