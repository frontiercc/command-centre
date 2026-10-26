// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * getClassifierQueueDepth — anti-phantom-queue regression coverage.
 *
 * An earlier release shipped a "N unclassified / Run-now classifies 0" bug: a
 * queue-depth counter built from its own hand-rolled predicate drifted from
 * runCodeClassifierJob's actual candidate selection. This is fixed by
 * extracting the three candidate predicates (final / provisional /
 * finalise) into one shared factory, classifierCandidateWhere, consumed by
 * BOTH the job and this counter. The decisive test below proves the fix by
 * running the REAL job end-to-end and asserting the counter agrees
 * afterwards — not by re-testing the predicate logic in isolation.
 *
 * Harness mirrors test/code-pulse-classifier-job.test.ts exactly: the real
 * (temp, fully-migrated) Postgres test DB via createTestDatabase(), direct
 * code_session_stats/code_session_classifications seeding, and only the
 * Anthropic SDK mocked.
 *
 * Timing note: runCodeClassifierJob() always computes `now` from the real
 * wall clock (Date.now()), it takes no injectable clock. So this test
 * seeds sessions relative to the real NOW (same convention as the job
 * test's own NOW constant) rather than an arbitrary fixed epoch — a fixed
 * "now" like 2_000_000_000 (year 2033) would seed timestamps the real job
 * wouldn't recognise as idle/ended when it computes its own real cutoff,
 * decoupling the seed from what's actually being exercised.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import { seedUserSql } from './helpers/seed';
import type { TestSql } from './helpers/sql';

vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn();
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: { create: mockCreate },
    })),
    __mockCreate: mockCreate,
  };
});

async function getMockCreate() {
  const mod = await import('@anthropic-ai/sdk');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mod as any).__mockCreate as ReturnType<typeof vi.fn>;
}

function mockClassifierResponse(items: Array<{ session_id: string; work_type: string; tier: number; confidence: number }>) {
  return {
    content: [{ type: 'text', text: JSON.stringify(items) }],
  };
}

let sql: TestSql;
let cleanup: () => Promise<void>;
let getClassifierQueueDepth: typeof import('@/lib/pulse/code/classifier').getClassifierQueueDepth;
let runCodeClassifierJob: typeof import('@/lib/pulse/code/classifier').runCodeClassifierJob;

const NOW = Math.floor(Date.now() / 1000);
const MIN = 60;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const mod = await import('@/lib/pulse/code/classifier');
  getClassifierQueueDepth = mod.getClassifierQueueDepth;
  runCodeClassifierJob = mod.runCodeClassifierJob;

  await seedUserSql(sql, 'user-1');
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`DELETE FROM code_session_classifications;
           DELETE FROM code_session_stats;
           DELETE FROM cowork_messages;
           DELETE FROM config WHERE key IN ('anthropic_ai_api_key', 'code_pulse_enabled', 'code_classifier_enabled');`);
  await sql.run(`INSERT INTO config (key, value) VALUES ('anthropic_ai_api_key', 'sk-test-key')`);
  (await getMockCreate()).mockReset();
});

async function seedSessionStats(opts: {
  session_id: string;
  last_at: number;
  first_at: number;
  user_msg_count: number;
  assistant_turns: number;
}) {
  await sql.run(
    `INSERT INTO code_session_stats
       (session_id, user_id, repo, git_branch, first_at, last_at, user_msg_count, assistant_turns, computed_at)
     VALUES (?, 'user-1', 'my-app', 'main', ?, ?, ?, ?, ?)`,
    [opts.session_id, opts.first_at, opts.last_at, opts.user_msg_count, opts.assistant_turns, NOW],
  );
}

async function seedClassification(opts: { session_id: string; status: string }) {
  await sql.run(
    `INSERT INTO code_session_classifications
       (session_id, user_id, work_type, tier, confidence, classifier_model, status, error, classified_at, provisional)
     VALUES (?, 'user-1', 'feature', 2, 0.8, 'claude-haiku-4-5-20251001', ?, NULL, ?, 0)`,
    [opts.session_id, opts.status, NOW],
  );
}

describe('getClassifierQueueDepth', () => {
  it('counts an ended, unclassified, active session as a final candidate', async () => {
    // ended (last_at well before cutoff = now - 1800), has activity, no classification row
    await seedSessionStats({ session_id: 's1', last_at: NOW - 4000, first_at: NOW - 8000, user_msg_count: 3, assistant_turns: 2 });

    const q = await getClassifierQueueDepth(NOW);
    expect(q.final).toBe(1);
    expect(q.provisional).toBe(0);
    expect(q.finalise).toBe(0);
    expect(q.total).toBe(1);
  });

  it('does not count a session that already has a classification row', async () => {
    await seedSessionStats({ session_id: 's2', last_at: NOW - 4000, first_at: NOW - 8000, user_msg_count: 3, assistant_turns: 2 });
    await seedClassification({ session_id: 's2', status: 'classified' });

    const q = await getClassifierQueueDepth(NOW);
    expect(q.total).toBe(0);
  });

  it('counts a long-running, still-active session as a provisional candidate', async () => {
    // Started 3h ago (past the 2h provisional floor), still active 5 min ago
    // (inside the 30-min idle window) — a provisional candidate, not final.
    await seedSessionStats({ session_id: 's3', last_at: NOW - 5 * MIN, first_at: NOW - 3 * 60 * MIN, user_msg_count: 3, assistant_turns: 2 });

    const q = await getClassifierQueueDepth(NOW);
    expect(q.provisional).toBe(1);
    expect(q.final).toBe(0);
    expect(q.total).toBe(1);
  });

  it('counts a stale provisional classification with new activity as a finalise candidate', async () => {
    await seedSessionStats({ session_id: 's4', last_at: NOW - 40 * MIN, first_at: NOW - 4 * 60 * MIN, user_msg_count: 3, assistant_turns: 2 });
    await sql.run(
      `INSERT INTO code_session_classifications
         (session_id, user_id, work_type, tier, confidence, classifier_model, status, error, classified_at, provisional)
       VALUES ('s4', 'user-1', 'feature', 2, 0.8, 'claude-haiku-4-5-20251001', 'classified', NULL, ?, 1)`,
      [NOW - 50 * MIN],
    ); // classified_at before last_at => new activity since provisional pass

    const q = await getClassifierQueueDepth(NOW);
    expect(q.finalise).toBe(1);
    expect(q.total).toBe(1);
  });

  // Anti-phantom-queue regression: the job and the counter MUST agree
  // end-to-end. This is the failure mode ("N unclassified /
  // Run-now classifies 0") and the whole point of this file.
  it('after a full runCodeClassifierJob run, queue depth is 0', async () => {
    // Seed several ended, unclassified, active sessions (final candidates).
    for (const id of ['j1', 'j2', 'j3']) {
      await seedSessionStats({ session_id: id, last_at: NOW - 4000, first_at: NOW - 8000, user_msg_count: 3, assistant_turns: 2 });
    }
    expect((await getClassifierQueueDepth(NOW)).total).toBe(3);

    // Run the real job with a mocked Anthropic client returning valid
    // classifications for each seeded session.
    (await getMockCreate()).mockResolvedValue(mockClassifierResponse([
      { session_id: 'j1', work_type: 'feature', tier: 2, confidence: 0.8 },
      { session_id: 'j2', work_type: 'bugfix', tier: 1, confidence: 0.7 },
      { session_id: 'j3', work_type: 'refactor', tier: 3, confidence: 0.9 },
    ]));

    const result = await runCodeClassifierJob();
    expect(result.classified).toBe(3);
    expect(result.failed).toBe(0);

    // Every candidate now has a classification row — the queue the counter
    // reports is empty. (No `now` argument needed: with classification rows
    // in place, final/provisional's isNull(csc.session_id) and finalise's
    // provisional=1 conditions are false regardless of the clock.)
    expect((await getClassifierQueueDepth()).total).toBe(0);
  });
});
