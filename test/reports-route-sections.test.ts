// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// POST /api/ai/report with no section list used to generate every section,
// so a viewer could get the admin|manager-only cost sections (FinOps, Spend
// Review) by leaving `sections` out. With no list the route now generates the
// sections this caller may see; a list is filtered as before.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

let sessionResult: { authenticated: boolean; role?: string; userId?: string; email?: string };

vi.mock('@/lib/auth/admin-auth', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/admin-auth')>();
  return { ...actual, getAdminSession: vi.fn(() => sessionResult) };
});
vi.mock('@/lib/audit/log', () => ({ logAccess: vi.fn() }));
vi.mock('@/lib/db/queries', () => ({
  getReports: vi.fn(async () => []),
  getReportById: vi.fn(async () => null),
  insertReport: vi.fn(async () => {}),
}));
vi.mock('@/lib/config', () => ({
  getAllConfig: vi.fn(async () => ({ chargebackEnabled: true, useCasesEnabled: true, gdprApplicable: true, lgpdApplicable: false, humanTimeEnabled: 'false', humanTimeCodeEnabled: '' })),
}));
const generate = vi.fn<(...args: unknown[]) => Promise<string>>(async () => '## Executive Summary\nx');
vi.mock('@/lib/anthropic/ai', () => ({ generateGovernanceReport: (...args: unknown[]) => generate(...args) }));

let route: typeof import('../app/api/ai/report/route');

beforeAll(async () => {
  route = await import('../app/api/ai/report/route');
});
beforeEach(() => generate.mockClear());

function post(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/ai/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ period_start: '2026-09-01', period_end: '2026-09-30', ...body }),
  });
}

async function sectionsFor(role: string, body: Record<string, unknown>): Promise<string[]> {
  sessionResult = { authenticated: true, role, userId: 'u1', email: 'u@x.com' };
  const res = await route.POST(post(body));
  expect(res.status).toBe(200);
  return generate.mock.calls[0][2] as string[];
}

describe('POST /api/ai/report section gating', () => {
  it('a viewer sending no section list gets no cost sections', async () => {
    const sections = await sectionsFor('viewer', {});
    expect(sections).not.toContain('finops');
    expect(sections).not.toContain('spend_review');
    expect(sections).toContain('executive_summary');
    expect(sections).toContain('use_cases');
  });

  it('a viewer asking for cost sections by name still does not get them', async () => {
    const sections = await sectionsFor('viewer', { sections: ['finops', 'spend_review', 'alerts'] });
    expect(sections).toEqual(['alerts']);
  });

  it('an admin or manager sending no section list gets the cost sections', async () => {
    for (const role of ['admin', 'manager']) {
      generate.mockClear();
      const sections = await sectionsFor(role, {});
      expect(sections).toContain('finops');
      expect(sections).toContain('spend_review');
    }
  });

  it('a section behind a switched-off feature is never generated', async () => {
    const sections = await sectionsFor('admin', {});
    expect(sections).not.toContain('lgpd');
    expect(sections).not.toContain('human_time');
  });
});
