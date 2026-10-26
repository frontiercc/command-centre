// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// These detectors call getTypedClient() (lib/db/client.ts) directly, so
// they are tested on the same real-DB harness the sibling files in this repo already use
// (test/pulse-batch-metrics.test.ts, test/pulse-ors-detail.test.ts) — seed
// real rows via createTestDatabase(), await the now-async detectors, assert on the
// real pulse_events rows they write. computeUserDds (used internally by
// detectFrontierPushes for depth_threshold_crossed) is exercised for real
// too, via seeded classification volume, rather than mocked.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { TestSql } from '../helpers/sql';
import { createTestDatabase } from '../helpers/db';
import { seedUserSql } from '../helpers/seed';

let sql: TestSql;
let cleanup: () => Promise<void>;

let detectFrontierPushes: typeof import('@/lib/pulse/events/frontier').detectFrontierPushes;
let detectCapabilityCreation: typeof import('@/lib/pulse/events/capability').detectCapabilityCreation;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  detectFrontierPushes = (await import('@/lib/pulse/events/frontier')).detectFrontierPushes;
  detectCapabilityCreation = (await import('@/lib/pulse/events/capability')).detectCapabilityCreation;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`
    DELETE FROM pulse_events;
    DELETE FROM pulse_classifications;
    DELETE FROM cowork_messages;
    DELETE FROM users;
  `);
});

let msgSeq = 0;
let classSeq = 0;

async function seedMessage(userId: string, occurredAt: number): Promise<string> {
  const msgId = `msg-${++msgSeq}`;
  await sql.run(`INSERT INTO cowork_messages
       (id, session_id, user_id, message_type, role, content_preview, occurred_at, ingested_at)
     VALUES (?, 'sess-1', ?, 'cowork_user_message', 'user', 'do the thing', ?, ?)`, [msgId, userId, occurredAt, occurredAt]);
  return msgId;
}

/** Seed a classified pulse_classifications row (+ backing cowork_messages row). Returns its id. */
async function seedClassification(opts: {
  userId: string;
  tier: number;
  taskType: string;
  occurredAt?: number;
  frontierPushCandidate?: 0 | 1;
  capabilityCreationCandidate?: 0 | 1;
}): Promise<number> {
  const occurredAt = opts.occurredAt ?? NOW;
  const msgId = await seedMessage(opts.userId, occurredAt);
  const id = ++classSeq;
  await sql.run(`INSERT INTO pulse_classifications
       (id, cowork_message_id, user_id, tier, task_type, frontier_push_candidate,
        capability_creation_candidate, classifier_confidence, classifier_model,
        classifier_status, classified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0.9, 'test-model', 'classified', ?)`, [id,
    msgId,
    opts.userId,
    opts.tier,
    opts.taskType,
    opts.frontierPushCandidate ?? 1,
    opts.capabilityCreationCandidate ?? 0,
    occurredAt]);
  return id;
}

async function pulseEventTypesFor(userId: string): Promise<string[]> {
  return ((await sql.all(`SELECT event_type FROM pulse_events WHERE user_id = ?`, [userId])) as Array<{ event_type: string }>)
    .map((r) => r.event_type);
}

async function pulseEventCount(): Promise<number> {
  return ((await sql.get(`SELECT COUNT(*) AS cnt FROM pulse_events`)) as { cnt: number }).cnt;
}

// ─── detectFrontierPushes tests ───────────────────────────────────────────────

describe('detectFrontierPushes', () => {
  it('does nothing when classificationIds is empty', async () => {
    await detectFrontierPushes([]);
    expect(await pulseEventCount()).toBe(0);
  });

  it('ignores classifications without frontier_push_candidate=1', async () => {
    await seedUserSql(sql, 'user-ignored');
    const id = await seedClassification({
      userId: 'user-ignored', tier: 3, taskType: 'autonomous_workflow', frontierPushCandidate: 0,
    });

    await detectFrontierPushes([id]);
    expect(await pulseEventCount()).toBe(0);
  });

  it('tier_3_first fires on first Tier 3 classification', async () => {
    await seedUserSql(sql, 'sarah-reeve');
    await sql.run(`UPDATE users SET team_id = 'team-alpha' WHERE id = 'sarah-reeve'`);
    const id = await seedClassification({ userId: 'sarah-reeve', tier: 3, taskType: 'autonomous_workflow' });

    await detectFrontierPushes([id]);

    expect(await pulseEventTypesFor('sarah-reeve')).toContain('tier_3_first');
  });

  it('tier_3_first does NOT fire on a second Tier 3 (event already exists)', async () => {
    await seedUserSql(sql, 'sarah-reeve-2');
    await sql.run(`INSERT INTO pulse_events (user_id, event_type, status, title, detected_at)
       VALUES ('sarah-reeve-2', 'tier_3_first', 'confirmed', 'First Tier 3 task', ?)`, [NOW - DAY]);
    const id = await seedClassification({ userId: 'sarah-reeve-2', tier: 3, taskType: 'synthesis' });

    await detectFrontierPushes([id]);

    const tier3FirstCount = ((await sql.get(`SELECT COUNT(*) AS cnt FROM pulse_events WHERE user_id = 'sarah-reeve-2' AND event_type = 'tier_3_first'`)) as { cnt: number }).cnt;
    expect(tier3FirstCount).toBe(1);
  });

  it('frontier_push fires on first autonomous_workflow, not repeated', async () => {
    await seedUserSql(sql, 'marcus-jones');
    await sql.run(`UPDATE users SET team_id = 'team-beta' WHERE id = 'marcus-jones'`);

    const id1 = await seedClassification({ userId: 'marcus-jones', tier: 3, taskType: 'autonomous_workflow' });
    await detectFrontierPushes([id1]);
    expect(await pulseEventTypesFor('marcus-jones')).toContain('frontier_push');

    const id2 = await seedClassification({ userId: 'marcus-jones', tier: 3, taskType: 'autonomous_workflow' });
    await detectFrontierPushes([id2]);

    const frontierPushCount = ((await sql.get(`SELECT COUNT(*) AS cnt FROM pulse_events WHERE user_id = 'marcus-jones' AND event_type = 'frontier_push'`)) as { cnt: number }).cnt;
    expect(frontierPushCount).toBe(1);
  });

  it('depth_threshold_crossed fires when DDS crosses 2.0 for the first time', async () => {
    await seedUserSql(sql, 'priya-kapoor');
    await sql.run(`UPDATE users SET team_id = 'team-gamma' WHERE id = 'priya-kapoor'`);

    // All Tier 3 in the 14-day DDS window → DDS = 3.0, comfortably over the 2.0 threshold.
    await seedClassification({ userId: 'priya-kapoor', tier: 3, taskType: 'general', occurredAt: NOW - DAY });
    await seedClassification({ userId: 'priya-kapoor', tier: 3, taskType: 'general', occurredAt: NOW - DAY });
    const id = await seedClassification({ userId: 'priya-kapoor', tier: 3, taskType: 'capability_creation' });

    await detectFrontierPushes([id]);

    expect(await pulseEventTypesFor('priya-kapoor')).toContain('depth_threshold_crossed');
  });

  it('depth_threshold_crossed does NOT fire again after already being recorded', async () => {
    await seedUserSql(sql, 'priya-kapoor-2');
    await sql.run(`INSERT INTO pulse_events (user_id, event_type, status, title, detected_at)
       VALUES ('priya-kapoor-2', 'depth_threshold_crossed', 'confirmed', 'Delegation depth milestone', ?)`, [NOW - DAY]);
    await seedClassification({ userId: 'priya-kapoor-2', tier: 3, taskType: 'general', occurredAt: NOW - DAY });
    const id = await seedClassification({ userId: 'priya-kapoor-2', tier: 3, taskType: 'synthesis' });

    await detectFrontierPushes([id]);

    const depthCount = ((await sql.get(`SELECT COUNT(*) AS cnt FROM pulse_events WHERE user_id = 'priya-kapoor-2' AND event_type = 'depth_threshold_crossed'`)) as { cnt: number }).cnt;
    expect(depthCount).toBe(1);
  });

  it('depth_threshold_crossed does NOT fire when DDS < 2.0', async () => {
    await seedUserSql(sql, 'user-low-dds');
    // A single Tier 1 event in the 14-day DDS window → DDS = 1.0, below the
    // 2.0 threshold (a single Tier 2 event would give exactly 2.0, which the
    // `dds >= 2.0` check treats as crossed — Tier 1 stays unambiguously below).
    const id = await seedClassification({ userId: 'user-low-dds', tier: 1, taskType: 'synthesis' });

    await detectFrontierPushes([id]);

    expect(await pulseEventTypesFor('user-low-dds')).not.toContain('depth_threshold_crossed');
  });
});

// ─── detectCapabilityCreation tests ──────────────────────────────────────────

describe('detectCapabilityCreation', () => {
  it('does nothing when classificationIds is empty', async () => {
    await detectCapabilityCreation([]);
    expect(await pulseEventCount()).toBe(0);
  });

  it('ignores classifications without capability_creation_candidate=1', async () => {
    await seedUserSql(sql, 'user-ignored-cap');
    const id = await seedClassification({
      userId: 'user-ignored-cap', tier: 3, taskType: 'capability_creation', capabilityCreationCandidate: 0,
    });

    await detectCapabilityCreation([id]);
    expect(await pulseEventCount()).toBe(0);
  });

  it('writes a candidate row when none exists for this cowork_message_id', async () => {
    await seedUserSql(sql, 'sarah-reeve-cap');
    await sql.run(`UPDATE users SET team_id = 'team-alpha' WHERE id = 'sarah-reeve-cap'`);
    const id = await seedClassification({
      userId: 'sarah-reeve-cap', tier: 3, taskType: 'capability_creation', capabilityCreationCandidate: 1,
    });

    await detectCapabilityCreation([id]);

    const rows = (await sql.all(`SELECT user_id, status, event_type, cowork_message_id FROM pulse_events WHERE user_id = 'sarah-reeve-cap'`)) as Array<{ user_id: string; status: string; event_type: string; cowork_message_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('candidate');
    expect(rows[0].event_type).toBe('capability_creation');
  });

  it('suppresses duplicate — does not write when candidate/confirmed already exists', async () => {
    await seedUserSql(sql, 'sarah-reeve-cap-2');
    const id = await seedClassification({
      userId: 'sarah-reeve-cap-2', tier: 3, taskType: 'capability_creation', capabilityCreationCandidate: 1,
    });
    const msgId = ((await sql.get(`SELECT cowork_message_id FROM pulse_classifications WHERE id = ?`, [id])) as { cowork_message_id: string }).cowork_message_id;
    await sql.run(`INSERT INTO pulse_events (user_id, event_type, status, title, cowork_message_id, detected_at)
       VALUES ('sarah-reeve-cap-2', 'capability_creation', 'candidate', 'New capability', ?, ?)`, [msgId, NOW - DAY]);

    await detectCapabilityCreation([id]);

    expect(await pulseEventCount()).toBe(1);
  });

  it('processes multiple classifications, writes one candidate per new message', async () => {
    await seedUserSql(sql, 'priya-kapoor-cap');
    const id1 = await seedClassification({
      userId: 'priya-kapoor-cap', tier: 3, taskType: 'capability_creation', capabilityCreationCandidate: 1,
    });
    const id2 = await seedClassification({
      userId: 'priya-kapoor-cap', tier: 3, taskType: 'autonomous_workflow', capabilityCreationCandidate: 1,
    });

    await detectCapabilityCreation([id1, id2]);

    expect(await pulseEventCount()).toBe(2);
  });
});
