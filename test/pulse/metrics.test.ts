// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// These metrics call getTypedClient() (lib/db/client.ts) directly, so this
// file uses the same real-DB harness the sibling files
// in this repo already use (test/pulse-batch-metrics.test.ts,
// test/pulse-ors-detail.test.ts, test/pulse-psr-suggest.test.ts) — seed real
// rows via createTestDatabase(), await the now-async metric functions, assert on
// real computed values. Scenarios/assertions are preserved from the original
// mock-based file wherever a real-data equivalent exists.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { TestSql } from '../helpers/sql';
import { createTestDatabase } from '../helpers/db';
import { seedUserSql } from '../helpers/seed';

let sql: TestSql;
let cleanup: () => Promise<void>;

let computeUserOti: typeof import('@/lib/pulse/metrics/oti').computeUserOti;
let computeTeamOti: typeof import('@/lib/pulse/metrics/oti').computeTeamOti;
let computeUserDds: typeof import('@/lib/pulse/metrics/dds').computeUserDds;
let computeTeamDds: typeof import('@/lib/pulse/metrics/dds').computeTeamDds;
let computeTeamPsr: typeof import('@/lib/pulse/metrics/psr').computeTeamPsr;
let computeTeamOrs: typeof import('@/lib/pulse/metrics/ors').computeTeamOrs;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

/** Build a unix timestamp N days before NOW */
function daysAgo(n: number): number {
  return NOW - n * DAY;
}

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  computeUserOti = (await import('@/lib/pulse/metrics/oti')).computeUserOti;
  computeTeamOti = (await import('@/lib/pulse/metrics/oti')).computeTeamOti;
  computeUserDds = (await import('@/lib/pulse/metrics/dds')).computeUserDds;
  computeTeamDds = (await import('@/lib/pulse/metrics/dds')).computeTeamDds;
  computeTeamPsr = (await import('@/lib/pulse/metrics/psr')).computeTeamPsr;
  computeTeamOrs = (await import('@/lib/pulse/metrics/ors')).computeTeamOrs;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`
    DELETE FROM pulse_classifications;
    DELETE FROM pulse_events;
    DELETE FROM pulse_baselines;
    DELETE FROM cowork_skill_invocations;
    DELETE FROM cowork_mcp_invocations;
    DELETE FROM cowork_messages;
    DELETE FROM users;
  `);
});

let msgSeq = 0;
let classSeq = 0;

/** Seed a cowork_messages row + a classified pulse_classifications row at a given tier/time. */
async function seedClassifiedEvent(userId: string, tier: number, occurredAt: number, taskType = 'general') {
  const msgId = `msg-${++msgSeq}`;
  await sql.run(`INSERT INTO cowork_messages
       (id, session_id, user_id, message_type, role, content_preview, occurred_at, ingested_at)
     VALUES (?, 'sess-1', ?, 'cowork_user_message', 'user', 'do the thing', ?, ?)`, [msgId, userId, occurredAt, occurredAt]);

  await sql.run(`INSERT INTO pulse_classifications
       (id, cowork_message_id, user_id, tier, task_type, classifier_confidence,
        classifier_model, classifier_status, classified_at)
     VALUES (?, ?, ?, ?, ?, 0.9, 'test-model', 'classified', ?)`, [++classSeq, msgId, userId, tier, taskType, occurredAt]);
}

// ─── OTI tests ────────────────────────────────────────────────────────────────

describe('computeUserOti (v2 — active-day rate-normalised, median of daily weighted output)', () => {
  it('returns null when user has no classified events (no baseline)', async () => {
    await seedUserSql(sql, 'user-no-events');
    expect(await computeUserOti('user-no-events')).toBeNull();
  });

  it('frozen baseline: median of daily weighted output resists a burst day', async () => {
    // v2 uses the MEDIAN of each active day's weighted output, so a single
    // day flooded with low-value prompts cannot inflate the baseline.
    await seedUserSql(sql, 'v2-frozen');
    // Baseline = user's first 30 classified events. Daily weighted [1, 1, 28]
    // → median 1 (the 28-event burst day is ignored), NOT the mean of 10.
    await seedClassifiedEvent('v2-frozen', 1, daysAgo(41));
    await seedClassifiedEvent('v2-frozen', 1, daysAgo(40));
    for (let i = 0; i < 28; i++) await seedClassifiedEvent('v2-frozen', 1, daysAgo(39));
    // Current rolling 7-day window: two active days, weighted [2, 2] → median 2.
    await seedClassifiedEvent('v2-frozen', 1, daysAgo(2));
    await seedClassifiedEvent('v2-frozen', 1, daysAgo(2));
    await seedClassifiedEvent('v2-frozen', 1, daysAgo(1));
    await seedClassifiedEvent('v2-frozen', 1, daysAgo(1));

    const r = await computeUserOti('v2-frozen');
    expect(r).not.toBeNull();
    expect(r!.value).toBeCloseTo(2.0, 5); // median current 2 / median baseline 1
    expect(r!.earlyRead).toBe(false); // 30 baseline events have accrued
    expect(r!.baselineFrozen).toBe(true);
  });

  it('early read: fewer than 30 classified events flags earlyRead=true', async () => {
    await seedUserSql(sql, 'v2-early');
    await seedClassifiedEvent('v2-early', 1, daysAgo(10)); // baseline day, weighted 1
    await seedClassifiedEvent('v2-early', 2, daysAgo(9)); // baseline day, weighted 2
    await seedClassifiedEvent('v2-early', 2, daysAgo(2)); // current day, weighted 2
    await seedClassifiedEvent('v2-early', 3, daysAgo(1)); // current day, weighted 3

    const r = await computeUserOti('v2-early');
    expect(r).not.toBeNull();
    expect(r!.earlyRead).toBe(true);
    expect(r!.baselineFrozen).toBe(false);
    // Baseline (all 4 events so far) daily weighted [1,2,2,3] → median 2;
    // current window daily weighted [2,3] → median 2.5; OTI = 1.25.
    expect(r!.value).toBeCloseTo(1.25, 5);
  });

  it('holds stale (value null, stale=true) when the current window has <2 active days', async () => {
    await seedUserSql(sql, 'v2-stale');
    // 30 baseline events across 3 early days so the baseline is frozen.
    for (let i = 0; i < 30; i++) await seedClassifiedEvent('v2-stale', 1, daysAgo(40 - (i % 3)));
    // Only ONE active day in the current 7-day window.
    await seedClassifiedEvent('v2-stale', 2, daysAgo(1));

    const r = await computeUserOti('v2-stale');
    expect(r).not.toBeNull();
    expect(r!.value).toBeNull();
    expect(r!.stale).toBe(true);
  });
});

describe('computeTeamOti', () => {
  it('returns null when team has no members', async () => {
    expect(await computeTeamOti('team-empty')).toBeNull();
  });
});

// ─── DDS tests ────────────────────────────────────────────────────────────────

describe('computeUserDds', () => {
  it('returns null when no events in 14-day window', async () => {
    await seedUserSql(sql, 'user-empty');
    expect(await computeUserDds('user-empty')).toBeNull();
  });

  it('all Tier 1 → DDS = 1.0', async () => {
    await seedUserSql(sql, 'user-t1');
    for (let i = 0; i < 5; i++) await seedClassifiedEvent('user-t1', 1, daysAgo(1));
    expect(await computeUserDds('user-t1')).toBeCloseTo(1.0, 5);
  });

  it('all Tier 3 → DDS = 3.0', async () => {
    await seedUserSql(sql, 'user-t3');
    for (let i = 0; i < 4; i++) await seedClassifiedEvent('user-t3', 3, daysAgo(1));
    expect(await computeUserDds('user-t3')).toBeCloseTo(3.0, 5);
  });

  it('mixed: 2xT1 + 2xT2 + 2xT3 → DDS = (2+4+6)/6 = 2.0', async () => {
    await seedUserSql(sql, 'user-mixed');
    await seedClassifiedEvent('user-mixed', 1, daysAgo(1));
    await seedClassifiedEvent('user-mixed', 1, daysAgo(1));
    await seedClassifiedEvent('user-mixed', 2, daysAgo(1));
    await seedClassifiedEvent('user-mixed', 2, daysAgo(1));
    await seedClassifiedEvent('user-mixed', 3, daysAgo(1));
    await seedClassifiedEvent('user-mixed', 3, daysAgo(1));
    expect(await computeUserDds('user-mixed')).toBeCloseTo(2.0, 5);
  });

  it('DDS increases as users take on Tier 3 work', async () => {
    await seedUserSql(sql, 'user-journey-1');
    for (let i = 0; i < 5; i++) await seedClassifiedEvent('user-journey-1', 1, daysAgo(1));
    const ddsWeek1 = await computeUserDds('user-journey-1');

    await seedUserSql(sql, 'user-journey-2');
    await seedClassifiedEvent('user-journey-2', 1, daysAgo(1));
    await seedClassifiedEvent('user-journey-2', 1, daysAgo(1));
    await seedClassifiedEvent('user-journey-2', 2, daysAgo(1));
    await seedClassifiedEvent('user-journey-2', 2, daysAgo(1));
    await seedClassifiedEvent('user-journey-2', 3, daysAgo(1));
    await seedClassifiedEvent('user-journey-2', 3, daysAgo(1));
    await seedClassifiedEvent('user-journey-2', 3, daysAgo(1));
    const ddsWeek6 = await computeUserDds('user-journey-2');

    expect(ddsWeek1).not.toBeNull();
    expect(ddsWeek6).not.toBeNull();
    expect(ddsWeek6!).toBeGreaterThan(ddsWeek1!);
  });
});

describe('computeTeamDds', () => {
  it('returns null when team has no members', async () => {
    expect(await computeTeamDds('team-empty')).toBeNull();
  });
});

// ─── PSR tests ────────────────────────────────────────────────────────────────

describe('computeTeamPsr', () => {
  it('returns null when no baseline row exists for the team', async () => {
    expect(await computeTeamPsr('team-no-baseline')).toBeNull();
  });

  it('returns null when baseline_process_count is null', async () => {
    await seedUserSql(sql, 'psr-setter-1');
    await sql.run(`INSERT INTO pulse_baselines (team_id, baseline_process_count, set_by, set_at)
       VALUES (?, NULL, ?, ?)`, ['team-null-baseline', 'psr-setter-1', NOW]);
    expect(await computeTeamPsr('team-null-baseline')).toBeNull();
  });

  it('returns null when baseline_process_count is 0 (avoids division by zero)', async () => {
    await seedUserSql(sql, 'psr-setter-2');
    await sql.run(`INSERT INTO pulse_baselines (team_id, baseline_process_count, set_by, set_at)
       VALUES (?, 0, ?, ?)`, ['team-zero-baseline', 'psr-setter-2', NOW]);
    expect(await computeTeamPsr('team-zero-baseline')).toBeNull();
  });

  it('computes PSR correctly: 3 confirmed events / 10 baseline = 0.3', async () => {
    await seedUserSql(sql, 'psr-setter-3');
    await sql.run(`INSERT INTO pulse_baselines (team_id, baseline_process_count, set_by, set_at)
       VALUES (?, 10, ?, ?)`, ['team-1', 'psr-setter-3', NOW]);

    await seedUserSql(sql, 'psr-user-1');
    await seedUserSql(sql, 'psr-user-2');
    await sql.run(`UPDATE users SET team_id = 'team-1' WHERE id IN ('psr-user-1', 'psr-user-2')`);

    for (let i = 0; i < 3; i++) {
      await sql.run(`INSERT INTO pulse_events (user_id, event_type, status, title, detected_at)
         VALUES (?, 'capability_creation', 'confirmed', 'New capability', ?)`, [i % 2 === 0 ? 'psr-user-1' : 'psr-user-2', NOW]);
    }
    // A non-confirmed event must not count.
    await sql.run(`INSERT INTO pulse_events (user_id, event_type, status, title, detected_at)
       VALUES ('psr-user-1', 'capability_creation', 'candidate', 'Not yet confirmed', ?)`, [NOW]);

    const result = await computeTeamPsr('team-1');
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(0.3, 5);
  });
});

// ─── ORS tests ────────────────────────────────────────────────────────────────
//
// ORS = (T2+_breadth × 0.3) + (connector_overlap × 0.4) + (skill_propagation × 0.3)
// All components derived from captured session data.

async function seedMessageFor(id: string, userId: string, occurredAt: number) {
  await sql.run(`INSERT INTO cowork_messages
       (id, session_id, user_id, message_type, role, content_preview, occurred_at, ingested_at)
     VALUES (?, ?, ?, 'cowork_user_message', 'user', 'do the thing', ?, ?)`, [id, `session-${id}`, userId, occurredAt, occurredAt]);
}

async function seedClassificationFor(id: number, messageId: string, userId: string, tier: number, classifiedAt: number) {
  await sql.run(`INSERT INTO pulse_classifications
       (id, cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classifier_status, classified_at)
     VALUES (?, ?, ?, ?, 'general', 0.9, 'test-model', 'classified', ?)`, [id, messageId, userId, tier, classifiedAt]);
}

describe('computeTeamOrs', () => {
  it('returns null when fewer than 2 active participants', async () => {
    await seedUserSql(sql, 'ors-u1');
    await sql.run(`UPDATE users SET team_id = 'team-solo' WHERE id = 'ors-u1'`);
    await seedMessageFor('ors-msg-1', 'ors-u1', NOW);
    await seedClassificationFor(1, 'ors-msg-1', 'ors-u1', 2, NOW);

    expect(await computeTeamOrs('team-solo')).toBeNull();
  });

  it('returns null when team has no members', async () => {
    expect(await computeTeamOrs('team-empty')).toBeNull();
  });

  it('ORS = T2+_breadth only when no connectors or skills used', async () => {
    // T2+_breadth = 2/2 = 1.0; connector_overlap = null; skill_propagation = null
    // reweighted to 1.0 (only component available)
    await seedUserSql(sql, 'ors-t2-1');
    await seedUserSql(sql, 'ors-t2-2');
    await sql.run(`UPDATE users SET team_id = 'team-t2-only' WHERE id IN ('ors-t2-1', 'ors-t2-2')`);
    await seedMessageFor('ors-t2-msg-1', 'ors-t2-1', NOW);
    await seedMessageFor('ors-t2-msg-2', 'ors-t2-2', NOW);
    await seedClassificationFor(10, 'ors-t2-msg-1', 'ors-t2-1', 2, NOW);
    await seedClassificationFor(11, 'ors-t2-msg-2', 'ors-t2-2', 2, NOW);

    const result = await computeTeamOrs('team-t2-only');
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(1.0, 5);
  });

  it('ORS combines all three components correctly', async () => {
    // T2+_breadth = 2/3 ≈ 0.6667
    // connector_overlap: linear(2/3=0.667) + github(1/3=0.333) → avg = 0.500
    // skill_propagation: 1 of 2 skills shared by 2+ → 0.5
    // ORS = (0.6667×0.3) + (0.500×0.4) + (0.5×0.3) = 0.200 + 0.200 + 0.150 = 0.550
    await seedUserSql(sql, 'ors-full-1');
    await seedUserSql(sql, 'ors-full-2');
    await seedUserSql(sql, 'ors-full-3');
    await sql.run(`UPDATE users SET team_id = 'team-full' WHERE id IN ('ors-full-1', 'ors-full-2', 'ors-full-3')`);

    await seedMessageFor('ors-full-msg-1', 'ors-full-1', NOW);
    await seedMessageFor('ors-full-msg-2', 'ors-full-2', NOW);
    await seedMessageFor('ors-full-msg-3', 'ors-full-3', NOW);
    // All 3 active; only 1 and 2 are Tier 2+.
    await seedClassificationFor(20, 'ors-full-msg-1', 'ors-full-1', 2, NOW);
    await seedClassificationFor(21, 'ors-full-msg-2', 'ors-full-2', 2, NOW);
    await seedClassificationFor(22, 'ors-full-msg-3', 'ors-full-3', 1, NOW);

    // Connector overlap is computed over active members (all 3), gated on
    // classifications with tier>=2, joined via session_id.
    await sql.run(`INSERT INTO cowork_mcp_invocations (id, user_id, session_id, mcp_server, mcp_tool, occurred_at)
       VALUES ('mcp-1', 'ors-full-1', 'session-ors-full-msg-1', 'linear', 'search', ?)`, [NOW]);
    await sql.run(`INSERT INTO cowork_mcp_invocations (id, user_id, session_id, mcp_server, mcp_tool, occurred_at)
       VALUES ('mcp-2', 'ors-full-2', 'session-ors-full-msg-2', 'linear', 'search', ?)`, [NOW]);
    await sql.run(`INSERT INTO cowork_mcp_invocations (id, user_id, session_id, mcp_server, mcp_tool, occurred_at)
       VALUES ('mcp-3', 'ors-full-1', 'session-ors-full-msg-1', 'github', 'search', ?)`, [NOW]);
    // github is used at tier>=2 only by user-1 via their own tier-2 session; user-3's
    // tier-1 session is excluded by the tier>=2 filter regardless of mcp usage.

    await sql.run(`INSERT INTO cowork_skill_invocations (id, user_id, session_id, skill_name, occurred_at)
       VALUES ('skill-1', 'ors-full-1', 'session-ors-full-msg-1', 'engineering:architecture', ?)`, [NOW]);
    await sql.run(`INSERT INTO cowork_skill_invocations (id, user_id, session_id, skill_name, occurred_at)
       VALUES ('skill-2', 'ors-full-2', 'session-ors-full-msg-2', 'engineering:architecture', ?)`, [NOW]);
    await sql.run(`INSERT INTO cowork_skill_invocations (id, user_id, session_id, skill_name, occurred_at)
       VALUES ('skill-3', 'ors-full-3', 'session-ors-full-msg-3', 'engineering:code-review', ?)`, [NOW]);

    const result = await computeTeamOrs('team-full');
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(0.55, 2);
  });

  it('ORS reweights when skill_propagation is null', async () => {
    // T2+_breadth = 1.0, connector_overlap = 1.0 (all members share same connector)
    // skill_propagation = null (no skills used)
    // reweighted: (1.0×0.3 + 1.0×0.4) / 0.7 = 1.0
    await seedUserSql(sql, 'ors-noskill-1');
    await seedUserSql(sql, 'ors-noskill-2');
    await sql.run(`UPDATE users SET team_id = 'team-no-skills' WHERE id IN ('ors-noskill-1', 'ors-noskill-2')`);
    await seedMessageFor('ors-noskill-msg-1', 'ors-noskill-1', NOW);
    await seedMessageFor('ors-noskill-msg-2', 'ors-noskill-2', NOW);
    await seedClassificationFor(30, 'ors-noskill-msg-1', 'ors-noskill-1', 2, NOW);
    await seedClassificationFor(31, 'ors-noskill-msg-2', 'ors-noskill-2', 2, NOW);

    await sql.run(`INSERT INTO cowork_mcp_invocations (id, user_id, session_id, mcp_server, mcp_tool, occurred_at)
       VALUES ('mcp-ns-1', 'ors-noskill-1', 'session-ors-noskill-msg-1', 'linear', 'search', ?)`, [NOW]);
    await sql.run(`INSERT INTO cowork_mcp_invocations (id, user_id, session_id, mcp_server, mcp_tool, occurred_at)
       VALUES ('mcp-ns-2', 'ors-noskill-2', 'session-ors-noskill-msg-2', 'linear', 'search', ?)`, [NOW]);

    const result = await computeTeamOrs('team-no-skills');
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(1.0, 5);
  });
});
