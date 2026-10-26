// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// End-to-end coverage for the classifier drain. House pattern: mock only
// @anthropic-ai/sdk, run the REAL runClassifierJob/runCodeClassifierJob
// against a real (temp) migrated DB via createTestDatabase() — never mock the job
// itself. One shared file-scope db/mock/hook setup serves every describe
// block below (including the pure-mechanics tests, which don't need it but
// aren't harmed by it) — resolveClassifierDrainMaxPasses's config-table
// tests and the classifier integration tests both need to read/write
// through the SAME real database connection that getConfigValue()'s
// getTypedClient() singleton binds to, and that binding happens once, here,
// before any test in this file runs. The file covers:
// drainJob's pure mechanics and the config-resolution helper; the DB-backed
// resolveClassifierDrainMaxPasses cases and the Cowork-classifier
// integration block; and a Code-classifier retry block reusing
// these same shared fixtures.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { drainJob, resolveClassifierDrainMaxPasses, type DrainPassResult } from '@/lib/pulse/drain';
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

function apiResponse(text: string) {
  return { content: [{ type: 'text', text }] };
}

function classifiedResponseFor(ids: string[]) {
  return apiResponse(JSON.stringify(ids.map(id => ({
    event_id: id, tier: 1, task_type: 'summarisation',
    frontier_push_candidate: false, capability_creation_candidate: false, confidence: 0.9,
  }))));
}

let sql: TestSql;
let cleanup: () => Promise<void>;
let runClassifierJob: typeof import('@/lib/pulse/classifier').runClassifierJob;

const NOW = Math.floor(Date.now() / 1000);

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  runClassifierJob = (await import('@/lib/pulse/classifier')).runClassifierJob;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`
    DELETE FROM pulse_classifications;
    DELETE FROM cowork_messages;
    DELETE FROM users;
    DELETE FROM config WHERE key IN ('anthropic_ai_api_key', 'classifier_drain_max_passes');
  `);
  await sql.run(`INSERT INTO config (key, value) VALUES ('anthropic_ai_api_key', 'sk-test-key')`);
  await seedUserSql(sql, 'user-1');
  (await getMockCreate()).mockReset();
});

async function seedCoworkMessage(id: string, occurredAt: number) {
  await sql.run(`
    INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, content_preview, occurred_at)
    VALUES (?, ?, 'user-1', 'cowork_user_message', 'cowork', 'test content', ?)
  `, [id, `sess-${id}`, occurredAt]);
}

describe('drainJob — pure mechanics', () => {
  it('drains a multi-batch queue to zero in one call', async () => {
    let remaining = 47; // two batches of 25 then a smaller one
    const runOnce = vi.fn(async (): Promise<DrainPassResult> => {
      const take = Math.min(25, remaining);
      remaining -= take;
      return { selected: take, classified: take, failed: 0 };
    });

    const result = await drainJob(runOnce, { maxPasses: 5 });

    expect(remaining).toBe(0);
    // Pass 1: selected 25 (classified 25, remaining 22) — nonzero, keeps going.
    // Pass 2: selected 22 (classified 22, remaining 0) — nonzero, keeps going.
    // Pass 3: selected 0 (nothing left) — the empty-queue check stops it here.
    expect(result.passes).toBe(3);
    expect(result.classified).toBe(47);
  });

  it('the pass cap bounds a larger queue and leaves the remainder', async () => {
    let remaining = 200;
    const runOnce = vi.fn(async (): Promise<DrainPassResult> => {
      const take = Math.min(25, remaining);
      remaining -= take;
      return { selected: take, classified: take, failed: 0 };
    });

    const result = await drainJob(runOnce, { maxPasses: 3 });

    expect(result.passes).toBe(3);
    expect(remaining).toBe(125); // 200 - 3*25 — the cap stopped it, queue not empty
    expect(runOnce).toHaveBeenCalledTimes(3);
  });

  it('a routine one-row failure inside a batch does not stop the drain', async () => {
    let calls = 0;
    const runOnce = vi.fn(async (): Promise<DrainPassResult> => {
      calls++;
      if (calls === 1) return { selected: 25, classified: 24, failed: 1 };
      return { selected: 0, classified: 0, failed: 0 };
    });

    const result = await drainJob(runOnce, { maxPasses: 5 });

    expect(result.passes).toBe(2);
    expect(result.classified).toBe(24);
    expect(result.failed).toBe(1);
  });

  it('shouldContinue returning false stops the drain between passes', async () => {
    let calls = 0;
    const runOnce = vi.fn(async (): Promise<DrainPassResult> => {
      calls++;
      return { selected: 25, classified: 25, failed: 0 }; // pretend infinite backlog
    });

    const result = await drainJob(runOnce, {
      maxPasses: 10,
      shouldContinue: () => calls < 2,
    });

    expect(result.passes).toBe(2);
    expect(runOnce).toHaveBeenCalledTimes(2);
  });

  it('the budget stops a run mid-queue via the injected clock', async () => {
    let clock = 0;
    const runOnce = vi.fn(async (): Promise<DrainPassResult> => {
      clock += 25_000; // each pass "takes" 25s of injected time
      return { selected: 25, classified: 25, failed: 0 }; // infinite backlog
    });

    const result = await drainJob(runOnce, {
      maxPasses: 10,
      budgetMs: 60_000,
      now: () => clock,
    });

    // Budget is checked BEFORE a pass starts: 0<60000 -> pass1 (clock=25000),
    // 25000<60000 -> pass2 (clock=50000), 50000<60000 -> pass3 (clock=75000),
    // 75000>=60000 -> stop before pass4.
    expect(result.passes).toBe(3);
  });
});

describe('resolveClassifierDrainMaxPasses', () => {
  it('runs five passes when the config key has never been set', async () => {
    await expect(resolveClassifierDrainMaxPasses()).resolves.toBe(5);
  });

  it('honours an explicit value read from config', async () => {
    await sql.run(`INSERT INTO config (key, value) VALUES ('classifier_drain_max_passes', '1')`);
    await expect(resolveClassifierDrainMaxPasses()).resolves.toBe(1);
  });

  it('falls back to five on a non-numeric value rather than running zero passes', async () => {
    await sql.run(`INSERT INTO config (key, value) VALUES ('classifier_drain_max_passes', 'not-a-number')`);
    await expect(resolveClassifierDrainMaxPasses()).resolves.toBe(5);
  });
});

describe('drainJob — Cowork classifier integration', () => {
  it('an empty queue makes no Anthropic call', async () => {
    const mockCreate = await getMockCreate();

    const result = await drainJob(runClassifierJob, { maxPasses: 5 });

    expect(result.passes).toBe(1); // one pass ran, found nothing, selected:0 stopped it
    expect(result.classified).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('a wholly failed pass stops the drain and charges exactly one attempt', async () => {
    await seedCoworkMessage('cw-1', NOW - 100);
    const mockCreate = await getMockCreate();
    mockCreate.mockRejectedValue(new Error('Network error'));

    const result = await drainJob(runClassifierJob, { maxPasses: 5 });

    expect(result.passes).toBe(1);
    expect(result.classified).toBe(0);
    expect(result.failed).toBe(1);
    expect(mockCreate).toHaveBeenCalledTimes(1);

    const row = (await sql.get(`SELECT classifier_attempts, classifier_status FROM pulse_classifications WHERE cowork_message_id = 'cw-1'`)) as { classifier_attempts: number; classifier_status: string };
    expect(row.classifier_attempts).toBe(1);
    expect(row.classifier_status).toBe('failed');
  });

  it('a multi-batch queue drains to zero in one run', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `cw-${i + 1}`);
    for (const [i, id] of ids.entries()) await seedCoworkMessage(id, NOW - (3000 - i)); // strictly increasing occurred_at

    const mockCreate = await getMockCreate();
    mockCreate
      .mockResolvedValueOnce(classifiedResponseFor(ids.slice(0, 25))) // BATCH_SIZE=25, ordered occurred_at ASC
      .mockResolvedValueOnce(classifiedResponseFor(ids.slice(25, 30)));

    const result = await drainJob(runClassifierJob, { maxPasses: 5 });

    // Pass 1: 25 selected/classified. Pass 2: 5 selected/classified, queue
    // now empty. Pass 3: selected 0 (the real job's own empty-queue check
    // returns early, before ever calling the Anthropic SDK) — drainJob
    // still counts it as a pass, so passes is 3, but mockCreate is only
    // called twice.
    expect(result.passes).toBe(3);
    expect(result.classified).toBe(30);
    expect(result.failed).toBe(0);
    expect(mockCreate).toHaveBeenCalledTimes(2);

    const remaining = (await sql.get(`
      SELECT COUNT(*) as c FROM cowork_messages cm
      WHERE cm.id NOT IN (SELECT cowork_message_id FROM pulse_classifications WHERE classifier_status = 'classified')
    `)) as { c: number };
    expect(remaining.c).toBe(0);
  });
});

let runCodeClassifierJob: typeof import('@/lib/pulse/code/classifier').runCodeClassifierJob;

beforeAll(async () => {
  runCodeClassifierJob = (await import('@/lib/pulse/code/classifier')).runCodeClassifierJob;
});

async function seedCodeSession(id: string) {
  const HOUR = 60 * 60;
  await sql.run(`
    INSERT INTO code_session_stats (session_id, user_id, repo, git_branch, first_at, last_at, user_msg_count, assistant_turns, computed_at)
    VALUES (?, 'user-1', 'my-app', 'main', ?, ?, 3, 5, ?)
  `, [id, NOW - 3 * HOUR, NOW - HOUR, NOW]);
}

describe('drainJob — Code classifier retry', () => {
  beforeEach(async () => {
    await sql.exec(`DELETE FROM code_session_classifications; DELETE FROM code_session_stats;`);
  });

  it('a Code failure is retried on the next run and excluded after five', async () => {
    await seedCodeSession('code-retry-1');
    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(apiResponse('not valid json'));

    // Simulate 5 separate scheduled runs, each hitting the same failing session.
    for (let i = 0; i < 5; i++) {
      await runCodeClassifierJob();
    }

    const row = (await sql.get(`SELECT attempts, status FROM code_session_classifications WHERE session_id = 'code-retry-1'`)) as { attempts: number; status: string };
    expect(row.attempts).toBe(5);
    expect(row.status).toBe('failed');

    // A 6th run must not re-select it — attempts >= 5 excludes it now.
    mockCreate.mockClear();
    const result = await runCodeClassifierJob();
    expect(result.selected).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('a session eligible for both final and finalise in the same run is processed exactly once', async () => {
    const HOUR = 60 * 60;
    // Seed a session already provisionally-failed, that has since gone
    // idle WITH new activity after the failed classification — this is
    // the exact overlap condition: it satisfies both final's retry-
    // admission (status=failed, attempts<5) and finalise's own condition
    // (provisional=1, idle, last_at > classified_at).
    await sql.run(`
      INSERT INTO code_session_stats (session_id, user_id, repo, git_branch, first_at, last_at, user_msg_count, assistant_turns, computed_at)
      VALUES ('code-overlap-1', 'user-1', 'my-app', 'main', ?, ?, 3, 5, ?)
    `, [NOW - 4 * HOUR, NOW - HOUR, NOW]);
    await sql.run(`
      INSERT INTO code_session_classifications (session_id, user_id, work_type, tier, confidence, classifier_model, status, error, classified_at, provisional, attempts)
      VALUES ('code-overlap-1', 'user-1', 'other', 1, 0, 'claude-haiku-4-5-20251001', 'failed', 'prior failure', ?, 1, 1)
    `, [NOW - 2 * HOUR]); // classified_at is BEFORE last_at (NOW - HOUR) — "new activity since the failed attempt"

    const mockCreate = await getMockCreate();
    mockCreate.mockResolvedValue(apiResponse('not valid json')); // fails again — makes a double-call obvious via attempts

    await runCodeClassifierJob();

    const row = (await sql.get(`SELECT attempts, status FROM code_session_classifications WHERE session_id = 'code-overlap-1'`)) as { attempts: number; status: string };
    // Without the fix, this session is processed twice in one run and
    // attempts jumps from 1 to 3; with the fix, exactly once, to 2.
    expect(row.attempts).toBe(2);
    expect(row.status).toBe('failed');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
