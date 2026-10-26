// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * runCodeClassifierJob — provisional session classification.
 *
 * Uses a real (temp) migrated test DB via createTestDatabase so the three
 * candidate-selection queries (final / provisional / finalise) are exercised
 * against actual SQL, not a hand-rolled mock. Only the Anthropic SDK is
 * mocked, following the pattern in test/pulse/classifier.test.ts.
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
let runCodeClassifierJob: typeof import('@/lib/pulse/code/classifier').runCodeClassifierJob;

const NOW = Math.floor(Date.now() / 1000);
const MIN = 60;
const HOUR = 60 * MIN;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;

  const mod = await import('@/lib/pulse/code/classifier');
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

async function seedSession(sessionId: string, opts: { firstAt: number; lastAt: number }) {
  await sql.run(
    `INSERT INTO code_session_stats
       (session_id, user_id, repo, git_branch, first_at, last_at, user_msg_count, assistant_turns, computed_at)
     VALUES (?, 'user-1', 'my-app', 'main', ?, ?, 3, 5, ?)`,
    [sessionId, opts.firstAt, opts.lastAt, NOW],
  );
}

async function seedClassification(sessionId: string, opts: { provisional: number; classifiedAt: number }) {
  await sql.run(
    `INSERT INTO code_session_classifications
       (session_id, user_id, work_type, tier, confidence, classifier_model, status, error, classified_at, provisional)
     VALUES (?, 'user-1', 'feature', 2, 0.8, 'claude-haiku-4-5-20251001', 'classified', NULL, ?, ?)`,
    [sessionId, opts.classifiedAt, opts.provisional],
  );
}

async function getClassification(sessionId: string) {
  return (await sql.get(`SELECT * FROM code_session_classifications WHERE session_id = ?`, [sessionId])) as
    | { session_id: string; provisional: number; classified_at: number; work_type: string; status: string }
    | undefined;
}

describe('runCodeClassifierJob — provisional pass', () => {
  it('classifies a long-running, still-active session as provisional', async () => {
    // Started 3h ago, still active 5 min ago — idle window not yet reached.
    await seedSession('s-long-running', { firstAt: NOW - 3 * HOUR, lastAt: NOW - 5 * MIN });
    (await getMockCreate()).mockResolvedValue(
      mockClassifierResponse([{ session_id: 's-long-running', work_type: 'feature', tier: 3, confidence: 0.9 }])
    );

    const result = await runCodeClassifierJob();
    expect(result.classified).toBe(1);

    const row = (await getClassification('s-long-running'));
    expect(row).toBeDefined();
    expect(row!.provisional).toBe(1);
    expect(row!.status).toBe('classified');
  });

  it('does not provisionally classify a short-lived active session (under the 2h age floor)', async () => {
    // Started 30 min ago, still active — too young for the provisional pass,
    // and not idle 30+ min either, so it should not appear as a candidate.
    await seedSession('s-young-active', { firstAt: NOW - 30 * MIN, lastAt: NOW - 5 * MIN });
    (await getMockCreate()).mockResolvedValue(mockClassifierResponse([]));

    const result = await runCodeClassifierJob();
    expect(result.classified).toBe(0);
    expect(result.failed).toBe(0);
    expect((await getClassification('s-young-active'))).toBeUndefined();
  });

  it('does not provisionally classify a session already idle 30+ minutes (goes through the final pass instead)', async () => {
    // Started 3h ago, idle for 45 min — this is a FINAL candidate, not provisional.
    await seedSession('s-idle-long', { firstAt: NOW - 3 * HOUR, lastAt: NOW - 45 * MIN });
    (await getMockCreate()).mockResolvedValue(
      mockClassifierResponse([{ session_id: 's-idle-long', work_type: 'bugfix', tier: 2, confidence: 0.7 }])
    );

    await runCodeClassifierJob();

    const row = (await getClassification('s-idle-long'));
    expect(row!.provisional).toBe(0);
  });

  it('does not re-provisionally-classify a session that already has any classification row', async () => {
    await seedSession('s-already-classified', { firstAt: NOW - 3 * HOUR, lastAt: NOW - 5 * MIN });
    await seedClassification('s-already-classified', { provisional: 1, classifiedAt: NOW - 10 * MIN });
    (await getMockCreate()).mockResolvedValue(mockClassifierResponse([]));

    const result = await runCodeClassifierJob();
    // s-already-classified is not idle 30+ min yet, so pass 3 shouldn't pick it up either
    expect(result.classified).toBe(0);
    expect(result.failed).toBe(0);
  });
});

describe('runCodeClassifierJob — finalisation pass', () => {
  it('re-classifies and clears the provisional flag once the session goes idle with new activity', async () => {
    const classifiedAt = NOW - 20 * MIN;
    await seedSession('s-finalise', { firstAt: NOW - 3 * HOUR, lastAt: NOW - 35 * MIN });
    // New activity happened AFTER the provisional classification (last_at > classified_at is
    // required, but for this test last_at must also be < now - 30min to be idle — use a
    // classified_at earlier than last_at).
    await sql.run(`UPDATE code_session_stats SET last_at = ? WHERE session_id = ?`, [NOW - 31 * MIN, 's-finalise']);
    await seedClassification('s-finalise', { provisional: 1, classifiedAt: NOW - 40 * MIN });

    (await getMockCreate()).mockResolvedValue(
      mockClassifierResponse([{ session_id: 's-finalise', work_type: 'feature', tier: 3, confidence: 0.95 }])
    );

    const result = await runCodeClassifierJob();
    expect(result.classified).toBe(1);

    const row = (await getClassification('s-finalise'));
    expect(row!.provisional).toBe(0);
    expect(row!.work_type).toBe('feature');
    expect(row!.classified_at).toBeGreaterThan(classifiedAt);
  });

  it('does NOT re-classify (no API call) a provisional session with no new activity since the provisional pass, but DOES finalise it (avoids double-billing while not stranding it forever)', async () => {
    const classifiedAt = NOW - 40 * MIN;
    // last_at is idle (45 min ago) but NOT after classified_at — no new activity,
    // so pass 3 (which would re-call the API) must not fire. The stranded-
    // finalisation pass (SQL-only, no API call) should still flip provisional
    // to 0 since the digest is unchanged and idle-final is reached.
    await seedSession('s-no-new-activity', { firstAt: NOW - 3 * HOUR, lastAt: NOW - 45 * MIN });
    await seedClassification('s-no-new-activity', { provisional: 1, classifiedAt });

    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(mockClassifierResponse([]));

    const result = await runCodeClassifierJob();
    expect(result.classified).toBe(0);
    expect(result.failed).toBe(0);
    // Anthropic API never called — no candidates in any *classifying* pass for this session
    expect(mockCreate).not.toHaveBeenCalled();

    const row = (await getClassification('s-no-new-activity'));
    expect(row!.provisional).toBe(0);
    expect(row!.classified_at).toBe(classifiedAt);
  });

  it('finalises a stranded provisional session with NO new activity once it goes idle (SQL-only, no API call)', async () => {
    // Classified provisionally while still active; last_at never advances
    // past classified_at (no new activity), but enough time passes that the
    // session is now idle past the quiet window — classified_at < last_at
    // is false, so pass 3 never fires, but this should still flip via the
    // stranded-finalisation pass without calling the classifier API.
    const classifiedAt = NOW - 45 * MIN;
    await seedSession('s-stranded', { firstAt: NOW - 4 * HOUR, lastAt: classifiedAt });
    await seedClassification('s-stranded', { provisional: 1, classifiedAt });

    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(mockClassifierResponse([]));

    const result = await runCodeClassifierJob();
    expect(result.classified).toBe(0);
    expect(result.failed).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();

    const row = (await getClassification('s-stranded'));
    expect(row!.provisional).toBe(0);
    // Finalisation is a plain flip — the rest of the row is untouched.
    expect(row!.classified_at).toBe(classifiedAt);
    expect(row!.work_type).toBe('feature');
  });

  it('does not re-finalise a session whose provisional row is already final (provisional=0)', async () => {
    await seedSession('s-already-final', { firstAt: NOW - 3 * HOUR, lastAt: NOW - 45 * MIN });
    await seedClassification('s-already-final', { provisional: 0, classifiedAt: NOW - 60 * MIN });

    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(mockClassifierResponse([]));

    const result = await runCodeClassifierJob();
    expect(result.classified).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('runCodeClassifierJob — mixed batch upsert correctness', () => {
  it('assigns provisional=0 to final-pass rows and provisional=1 to provisional-pass rows in the same batch', async () => {
    await seedSession('s-final', { firstAt: NOW - 3 * HOUR, lastAt: NOW - 40 * MIN }); // idle -> final
    await seedSession('s-provisional', { firstAt: NOW - 3 * HOUR, lastAt: NOW - 5 * MIN }); // still active -> provisional

    (await getMockCreate()).mockResolvedValue(mockClassifierResponse([
      { session_id: 's-final', work_type: 'bugfix', tier: 2, confidence: 0.6 },
      { session_id: 's-provisional', work_type: 'feature', tier: 3, confidence: 0.9 },
    ]));

    const result = await runCodeClassifierJob();
    expect(result.classified).toBe(2);
    expect((await getClassification('s-final'))!.provisional).toBe(0);
    expect((await getClassification('s-provisional'))!.provisional).toBe(1);
  });
});
