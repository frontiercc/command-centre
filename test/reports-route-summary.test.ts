// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// POST /api/ai/report stores the text under "## Executive Summary", up to the
// next heading, as the report's summary; without that heading, the opening.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/admin-auth', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth/admin-auth')>();
  return { ...actual, getAdminSession: vi.fn(() => ({ authenticated: true, role: 'admin', userId: 'u1', email: 'u@x.com' })) };
});
vi.mock('@/lib/audit/log', () => ({ logAccess: vi.fn() }));
const insertReport = vi.fn<(r: { content_summary: string }) => Promise<void>>(async () => {});
vi.mock('@/lib/db/queries', () => ({
  getReports: vi.fn(async () => []),
  getReportById: vi.fn(async () => null),
  insertReport: (r: { content_summary: string }) => insertReport(r),
}));
vi.mock('@/lib/config', () => ({
  getAllConfig: vi.fn(async () => ({ chargebackEnabled: false, useCasesEnabled: false, gdprApplicable: false, lgpdApplicable: false, humanTimeEnabled: 'false', humanTimeCodeEnabled: '' })),
}));
let reply = '';
vi.mock('@/lib/anthropic/ai', () => ({ generateGovernanceReport: async () => reply }));

let route: typeof import('../app/api/ai/report/route');

beforeAll(async () => {
  route = await import('../app/api/ai/report/route');
});
beforeEach(() => insertReport.mockClear());

async function summaryOf(md: string): Promise<string> {
  reply = md;
  const res = await route.POST(new NextRequest('http://localhost/api/ai/report', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  }));
  expect(res.status).toBe(200);
  return insertReport.mock.calls[0][0].content_summary;
}

describe('POST /api/ai/report summary', () => {
  it('takes the text under the Executive Summary heading, up to the next heading', async () => {
    expect(await summaryOf('# Report\n\n## Executive Summary\n\nPosture is good.\nTwo findings.\n\n## Usage\nMore.')).toBe('Posture is good.\nTwo findings.');
  });

  it('takes the rest of the report when no heading follows', async () => {
    expect(await summaryOf('## Executive Summary\nOnly this.')).toBe('Only this.');
  });

  it('falls back to the opening when there is no Executive Summary heading', async () => {
    expect(await summaryOf('# Report\nNo summary here.')).toBe('# Report\nNo summary here.');
  });
});
