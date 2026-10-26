// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Wiring: every briefing path asks the right helper for its model.
// Personal weekly briefings — the scheduled job and the on-demand 'user' /
// 'all_users' route calls — use getUserBriefingModel(); CIO and department
// briefings use getOrgBriefingModel(). The helpers are replaced with markers,
// so a path that asks the wrong one fails here even though both helpers are
// individually correct (test/config-briefing-model-default.test.ts).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import { seedUserSql } from './helpers/seed';
import type { TestSql } from './helpers/sql';

vi.mock('@/lib/anthropic/model', () => ({
  getUserBriefingModel: async () => 'USER-MODEL',
  getOrgBriefingModel: async () => 'ORG-MODEL',
  getCoreAiModel: async () => 'CORE-MODEL',
}));

const mockCreate = vi.fn().mockResolvedValue({
  content: [{ type: 'text', text: JSON.stringify({ headline: 'h', summary: 's', highlights: [], suggestions: [] }) }],
});
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));

// The on-demand route's generators, so the route test sees exactly which
// model it passes for each briefing type.
const genUser = vi.fn().mockResolvedValue(undefined);
const genCio = vi.fn().mockResolvedValue(undefined);
const genDept = vi.fn().mockResolvedValue(undefined);

let sessionResult: { authenticated: boolean; role?: string };
vi.mock('@/lib/auth/admin-auth', () => ({
  getAdminSession: vi.fn(() => sessionResult),
  canAccessPulseAdmin: (role?: string) => role === 'admin' || role === 'manager',
}));

let sql: TestSql;
let cleanup: () => Promise<void>;
const NOW = Math.floor(Date.now() / 1000);

beforeAll(async () => {
  ({ sql, cleanup } = await createTestDatabase());
  await sql.run("INSERT INTO config (key, value, updated_at) VALUES ('anthropic_ai_api_key', 'test-key', 0)");
  await seedUserSql(sql, 'u-active');
  await sql.run(
    `INSERT INTO cowork_messages
       (id, session_id, user_id, message_type, role, content_preview, occurred_at, ingested_at)
     VALUES ('m1', 'sess-1', 'u-active', 'cowork_user_message', 'user', 'do the thing', ?, ?)`,
    [NOW - 3600, NOW - 3600],
  );
  await sql.run(
    `INSERT INTO pulse_classifications
       (cowork_message_id, user_id, tier, task_type, classifier_confidence, classifier_model, classifier_status, classified_at)
     VALUES ('m1', 'u-active', 2, 'analysis', 0.9, 'x', 'classified', ?)`,
    [NOW - 3600],
  );
  sessionResult = { authenticated: true, role: 'admin' };
});
afterAll(async () => cleanup());
beforeEach(() => {
  mockCreate.mockClear();
  genUser.mockClear();
  genCio.mockClear();
  genDept.mockClear();
});

describe('scheduled personal weekly briefings', () => {
  it('runWeeklyBriefingJob calls the model with the personal briefing model', async () => {
    const { runWeeklyBriefingJob } = await import('@/lib/pulse/briefings/weekly');
    await runWeeklyBriefingJob();
    expect(mockCreate).toHaveBeenCalled();
    expect(mockCreate.mock.calls.every(c => c[0].model === 'USER-MODEL')).toBe(true);
  });
});

describe('on-demand briefing route', () => {
  async function post(body: unknown) {
    vi.resetModules();
    vi.doMock('@/lib/pulse/briefings/weekly', () => ({ generateUserWeeklyBriefing: genUser }));
    vi.doMock('@/lib/pulse/briefings/cio', () => ({ generateCioBriefing: genCio }));
    vi.doMock('@/lib/pulse/briefings/dept', () => ({ generateDeptBriefing: genDept }));
    const { POST } = await import('../app/api/pulse/briefing/route');
    return POST(new NextRequest('http://localhost/api/pulse/briefing', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }));
  }

  it("'user' and 'all_users' use the personal model", async () => {
    expect((await post({ type: 'user', userId: 'u-active' })).status).toBe(200);
    expect((await post({ type: 'all_users' })).status).toBe(200);
    expect(genUser).toHaveBeenCalledTimes(2);
    for (const call of genUser.mock.calls) expect(call[3]).toBe('USER-MODEL');
  });

  it("'cio' and 'dept' use the organisation model", async () => {
    expect((await post({ type: 'cio' })).status).toBe(200);
    expect((await post({ type: 'dept', dept: 'Finance' })).status).toBe(200);
    expect(genCio.mock.calls[0][2]).toBe('ORG-MODEL');
    expect(genDept.mock.calls[0][3]).toBe('ORG-MODEL');
  });
});
