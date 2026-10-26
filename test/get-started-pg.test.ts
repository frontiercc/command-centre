// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The dashboard's "Get started" panel: each setup step is worked out from what
// the install holds (lib/setup/status.ts); the first real telemetry is marked
// once and kept (lib/setup/first-telemetry.ts); and the route's actions.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import { seedUserSql } from './helpers/seed';
import type { TestSql } from './helpers/sql';

const session = { authenticated: true, userId: 'a1', email: 'a@test.local', role: 'admin' };
vi.mock('@/lib/auth/admin-auth', () => ({ getAdminSession: vi.fn(async () => session) }));
vi.mock('@/lib/audit/log', () => ({ logAccess: vi.fn(async () => {}) }));

let sql: TestSql;
let cleanup: () => Promise<void>;
let getSetupStatus: typeof import('@/lib/setup/status').getSetupStatus;
let fm: typeof import('@/lib/setup/first-telemetry');

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  ({ getSetupStatus } = await import('@/lib/setup/status'));
  fm = await import('@/lib/setup/first-telemetry');
});

afterAll(async () => cleanup());

const savedKey = process.env.ANTHROPIC_AI_API_KEY;
const savedSample = process.env.CCC_SAMPLE_DATA;

beforeEach(async () => {
  delete process.env.ANTHROPIC_AI_API_KEY;
  delete process.env.CCC_SAMPLE_DATA;
  fm.resetFirstTelemetryForTests();
  await sql.exec(`DELETE FROM config; DELETE FROM pulse_rubric_versions; DELETE FROM admin_users;
    DELETE FROM users; DELETE FROM cowork_messages; DELETE FROM code_otel_metrics; DELETE FROM chat_messages;`);
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_AI_API_KEY; else process.env.ANTHROPIC_AI_API_KEY = savedKey;
  if (savedSample === undefined) delete process.env.CCC_SAMPLE_DATA; else process.env.CCC_SAMPLE_DATA = savedSample;
});

describe('getSetupStatus', () => {
  it('a fresh install has nothing done and no sample data step', async () => {
    const s = await getSetupStatus();
    expect(s).toMatchObject({
      hidden: false, apiKey: false, claudeCodeAt: null, coworkAt: null,
      rubricReviewed: false, departmentsSet: false,
      sampleData: { available: false, loaded: false }, done: 0, complete: false,
    });
  });

  it('ticks each step from what the install holds, and is complete at five', async () => {
    process.env.ANTHROPIC_AI_API_KEY = 'sk-ant-test';
    await fm.noteFirstTelemetry('code', 1_790_000_000);
    await fm.noteFirstTelemetry('cowork', 1_790_000_100);
    await sql.run(`INSERT INTO pulse_rubric_versions (changed_by, changed_at, rubric_json) VALUES ('a', 1, '{}')`);
    await sql.run(`INSERT INTO admin_users (id, email, password_hash, role, department) VALUES ('a1', 'a@test.local', 'x', 'admin', 'Finance')`);

    const s = await getSetupStatus();
    expect(s).toMatchObject({
      apiKey: true, claudeCodeAt: 1_790_000_000, coworkAt: 1_790_000_100,
      rubricReviewed: true, departmentsSet: true, done: 5, complete: true,
    });
  });

  it('a blank department does not count', async () => {
    await sql.run(`INSERT INTO admin_users (id, email, password_hash, role, department) VALUES ('a1', 'a@test.local', 'x', 'admin', '  ')`);
    expect((await getSetupStatus()).departmentsSet).toBe(false);
  });

  it('offers sample data only where the command exists, and sees it once loaded', async () => {
    expect((await getSetupStatus()).sampleData.available).toBe(false);
    process.env.CCC_SAMPLE_DATA = '1';
    expect((await getSetupStatus()).sampleData).toEqual({ available: true, loaded: false });
    await seedUserSql(sql, 'acme-1', 'alex.morgan@acmecorp.example');
    expect((await getSetupStatus()).sampleData).toEqual({ available: true, loaded: true });
  });

  it('sample telemetry rows do not tick Claude Code or Cowork', async () => {
    await sql.run(`INSERT INTO cowork_messages (id, session_id, message_type, occurred_at, surface) VALUES ('ff-1', 's1', 'cowork_user_message', 1, 'cowork')`);
    await sql.run(`INSERT INTO cowork_messages (id, session_id, message_type, occurred_at, surface) VALUES ('ff-2', 's2', 'code_user_message', 1, 'code')`);
    const s = await getSetupStatus();
    expect(s.claudeCodeAt).toBeNull();
    expect(s.coworkAt).toBeNull();
  });

  it('the tiers step ticks when marked as reviewed, without a save', async () => {
    await sql.run(`INSERT INTO config (key, value) VALUES ('setup_rubric_reviewed', 'true')`);
    const s = await getSetupStatus();
    expect(s.rubricReviewed).toBe(true);
    expect(s.done).toBe(1);
  });

  it('reads Hide', async () => {
    await sql.run(`INSERT INTO config (key, value) VALUES ('setup_guide_hidden', 'true')`);
    expect((await getSetupStatus()).hidden).toBe(true);
  });
});

describe('noteFirstTelemetry', () => {
  it('keeps the first arrival', async () => {
    await fm.noteFirstTelemetry('cowork', 1000);
    fm.resetFirstTelemetryForTests(); // as a second process would
    await fm.noteFirstTelemetry('cowork', 2000);
    const row = await sql.get<{ value: string }>(`SELECT value FROM config WHERE key = 'setup_first_cowork_at'`);
    expect(row?.value).toBe('1000');
  });
});


describe('POST /api/get-started', () => {
  const post = async (body: unknown) => {
    const { POST } = await import('@/app/api/get-started/route');
    const res = await POST(new NextRequest('http://localhost/api/get-started', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    return res.status;
  };

  it('Mark as reviewed ticks the tiers step and leaves the panel showing', async () => {
    expect(await post({ action: 'rubric-reviewed' })).toBe(200);
    const s = await getSetupStatus();
    expect(s.rubricReviewed).toBe(true);
    expect(s.hidden).toBe(false);
  });

  it('Hide hides the panel', async () => {
    expect(await post({ action: 'hide' })).toBe(200);
    expect((await getSetupStatus()).hidden).toBe(true);
  });

  it('Show brings a hidden panel back', async () => {
    expect(await post({ action: 'hide' })).toBe(200);
    expect(await post({ action: 'show' })).toBe(200);
    expect((await getSetupStatus()).hidden).toBe(false);
  });

  it('Done ticks a step by hand, counts it, and keeps it once', async () => {
    const before = (await getSetupStatus()).done;
    expect(await post({ action: 'step-done', step: 'cowork' })).toBe(200);
    expect(await post({ action: 'step-done', step: 'cowork' })).toBe(200);
    expect(await post({ action: 'step-done', step: 'api-key' })).toBe(200);
    const s = await getSetupStatus();
    expect(s.markedDone).toEqual(['api-key', 'cowork']);
    expect(s.apiKey).toBe(true);
    expect(s.done).toBe(before + 2);
  });

  it('refuses Done for a step that does not exist', async () => {
    expect(await post({ action: 'step-done', step: 'drop-tables' })).toBe(400);
    expect(await post({ action: 'step-done' })).toBe(400);
  });

  it('refuses an unknown or missing action and changes nothing', async () => {
    expect(await post({ action: 'drop-tables' })).toBe(400);
    expect(await post({})).toBe(400);
    const s = await getSetupStatus();
    expect(s.hidden).toBe(false);
    expect(s.rubricReviewed).toBe(false);
  });
});
