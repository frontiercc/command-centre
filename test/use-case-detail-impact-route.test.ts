// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Route-level test for GET /api/use-cases/[id] gaining the additive Workflow
// Impact fields. Follows the invocation pattern of
// test/reports-route-access.test.ts (real handler, mocked session) and reuses
// the raw use_case_activation_weeks seeding convention from
// test/usecases-impact-builder.test.ts. buildUseCaseImpact runs for real
// against the test DB — only the session is mocked.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

const WEEK = 7 * 86400;

let sql: TestSql;
let cleanup: () => Promise<void>;

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string };
vi.mock('@/lib/auth/admin-auth', () => ({
  getAdminSession: vi.fn(() => sessionResult),
  canAccessPulseAdmin: (role?: string) => role === 'admin' || role === 'manager',
}));

function makeRequest(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`);
}

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`DELETE FROM use_case_week_matches; DELETE FROM use_case_activation_weeks;
           DELETE FROM use_cases; DELETE FROM config;`);
  sessionResult = { authenticated: true, role: 'admin', userId: 'admin-1', email: 'admin@example.com' };
});

async function enableUseCases() {
  const { saveConfig } = await import('@/lib/config');
  await saveConfig({ useCasesEnabled: 'true' });
}

describe('GET /api/use-cases/[id] — Workflow Impact fields', () => {
  it('returns impact.weeks.length === 13, null impactSummary pre-generation, and the pre-existing weeks field untouched', async () => {
    await enableUseCases();

    const { createUseCase } = await import('@/lib/usecases/queries');
    const uc = await createUseCase({ title: 'Impact Route UC', status: 'confirmed' });

    const { weekStarts } = await import('@/lib/pulse/period');
    const nowS = Math.floor(Date.now() / 1000);
    // Same window buildUseCaseImpact derives internally — seed its oldest week.
    const [oldestWindowWeek] = weekStarts(nowS - WEEK, 13);

    const { getTypedClient } = await import('@/lib/db/client');
    const { schema } = await import('@/lib/db/schema');
    const client = await getTypedClient();
    await client.insert(schema.useCaseActivationWeeks).values({
      use_case_id: uc.id, week_start: oldestWindowWeek, distinct_users: 1, session_count: 2,
      matched_messages: 1, updated_at: nowS, measured_duration_secs: 1800, engaged_secs: 300,
      tool_error_count: 1, edit_reject_count: 0, edit_accept_count: 2, flagged_count: 0,
    } as never).onConflictDoNothing();

    const { GET } = await import('@/app/api/use-cases/[id]/route');
    const res = await GET(makeRequest(`/api/use-cases/${uc.id}`), { params: Promise.resolve({ id: uc.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();

    // New additive fields.
    expect(body.impact).toBeDefined();
    expect(body.impact.weeks).toHaveLength(13);
    expect(body.impact.weeks[0].weekStart).toBe(oldestWindowWeek);
    expect(body.impact.weeks[0].durationSecs).toBe(1800);
    expect(body.impactSummary).toEqual({ text: null, generatedAt: null });

    // Pre-existing field untouched.
    expect(Array.isArray(body.weeks)).toBe(true);
  });
});
