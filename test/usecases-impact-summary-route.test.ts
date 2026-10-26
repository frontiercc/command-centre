// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Route-level test for POST /api/use-cases/[id]/impact-summary.
// Mocks only the LLM boundary
// (generateImpactSummary); saveImpactSummary + buildUseCaseImpact run for real
// against the test DB, so a success case genuinely proves persistence.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

let sql: TestSql;
let cleanup: () => Promise<void>;

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string };
const getAdminSessionMock = vi.fn(() => sessionResult);
vi.mock('@/lib/auth/admin-auth', () => ({
  getAdminSession: getAdminSessionMock,
  canAccessPulseAdmin: (role?: string) => role === 'admin' || role === 'manager',
}));

let generateImpactSummaryMock: ReturnType<typeof vi.fn>;
vi.mock('@/lib/usecases/impact-summary', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/usecases/impact-summary')>();
  return {
    ...actual,
    generateImpactSummary: (...args: unknown[]) => generateImpactSummaryMock(...args),
  };
});

function makeRequest(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, { method: 'POST' });
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
  getAdminSessionMock.mockClear();
  generateImpactSummaryMock = vi.fn(async () => ({ text: 'A grounded summary.' }));
});

async function enableUseCases() {
  const { saveConfig } = await import('@/lib/config');
  await saveConfig({ useCasesEnabled: 'true' });
}

async function seedUseCase() {
  const { createUseCase } = await import('@/lib/usecases/queries');
  return createUseCase({ title: 'Board-Pack Prep', status: 'confirmed' });
}

describe('POST /api/use-cases/[id]/impact-summary', () => {
  it('flag off -> 404 before any auth read', async () => {
    // useCasesEnabled defaults false (config table cleared in beforeEach, no enable call).
    const { POST } = await import('@/app/api/use-cases/[id]/impact-summary/route');
    const res = await POST(makeRequest('/api/use-cases/uc-1/impact-summary'), {
      params: Promise.resolve({ id: 'uc-1' }),
    });

    expect(res.status).toBe(404);
    expect(getAdminSessionMock).not.toHaveBeenCalled();
  });

  it('flag on + authed admin + generation success -> 200 {summary, generatedAt} and the row now carries the stored summary', async () => {
    await enableUseCases();
    const uc = await seedUseCase();

    const { POST } = await import('@/app/api/use-cases/[id]/impact-summary/route');
    const res = await POST(makeRequest(`/api/use-cases/${uc.id}/impact-summary`), {
      params: Promise.resolve({ id: uc.id }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toBe('A grounded summary.');
    expect(typeof body.generatedAt).toBe('number');

    // Direct row check — the use_cases row now carries the stored summary
    // (impact_summary isn't part of the UseCase query-layer type, so read raw).
    const row = (await sql.get('SELECT impact_summary, impact_summary_at FROM use_cases WHERE id = ?', [uc.id])) as
      { impact_summary: string; impact_summary_at: number };
    expect(row.impact_summary).toBe('A grounded summary.');
    expect(row.impact_summary_at).toBe(body.generatedAt);
  });

  it('generation returns null -> 502 {error} and nothing stored', async () => {
    await enableUseCases();
    const uc = await seedUseCase();
    generateImpactSummaryMock = vi.fn(async () => ({ text: null }));

    const { POST } = await import('@/app/api/use-cases/[id]/impact-summary/route');
    const res = await POST(makeRequest(`/api/use-cases/${uc.id}/impact-summary`), {
      params: Promise.resolve({ id: uc.id }),
    });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('Summary generation failed');

    const row = (await sql.get('SELECT impact_summary, impact_summary_at FROM use_cases WHERE id = ?', [uc.id])) as
      { impact_summary: string | null; impact_summary_at: number | null };
    expect(row.impact_summary).toBeNull();
    expect(row.impact_summary_at).toBeNull();
  });
});
