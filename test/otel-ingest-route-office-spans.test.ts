// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Claude in Office sends trace spans (service.name 'office-agent'). The ingest
// route hands those resources to lib/otel/office-receiver.ts and ignores every
// other span: a span carries tool inputs and file paths, which are never stored.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

type Payload = Record<string, unknown>;
const officeCalls: Payload[] = [];
const firstTelemetry: string[] = [];

vi.mock('@/lib/auth/ingest-auth', () => ({
  authenticateIngest: async () => ({ authenticated: true, isCollector: true, agentId: null }),
}));
vi.mock('@/lib/auth/rate-limit', () => ({ isRateLimited: () => false }));
vi.mock('@/lib/setup/first-telemetry', () => ({
  noteFirstTelemetry: async (product: string) => { firstTelemetry.push(product); },
}));
vi.mock('@/lib/otel/office-receiver', () => ({
  OFFICE_SERVICE_NAME: 'office-agent',
  processOfficeSpans: async (payload: Payload) => {
    officeCalls.push(payload);
    return { logsInserted: (payload.resourceSpans as unknown[]).length, skipped: 0, usersCreated: 0, sessionsCreated: 0, alertsFired: 0, errors: [] };
  },
}));
vi.mock('@/lib/otel/cowork-receiver', () => ({ processOtlpLogs: async () => ({ errors: [] }) }));
vi.mock('@/lib/otel/code-receiver', () => ({ processCodeOtlpLogs: async () => ({ errors: [] }) }));
vi.mock('@/lib/otel/code-metrics-receiver', () => ({ processCodeOtlpMetrics: async () => ({ errors: [] }) }));

const resourceSpan = (service: string) => ({
  resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
  scopeSpans: [{ spans: [{ traceId: 't', spanId: 's', name: 'agent.query', attributes: [] }] }],
});
const serviceOf = (entry: unknown) =>
  ((entry as { resource: { attributes: Array<{ key: string; value: { stringValue: string } }> } }).resource.attributes
    .find(a => a.key === 'service.name')!.value.stringValue);

async function post(body: unknown) {
  const { POST } = await import('@/app/api/otel/ingest/route');
  const req = new NextRequest('http://localhost/api/otel/ingest', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const res = await POST(req);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe('POST /api/otel/ingest routes Office spans to the Office receiver', () => {
  beforeEach(() => { officeCalls.length = 0; firstTelemetry.length = 0; });

  it('Office spans reach the Office receiver', async () => {
    const { status, body } = await post({ resourceSpans: [resourceSpan('office-agent'), resourceSpan('office-agent')] });
    expect(status).toBe(200);
    expect(officeCalls).toHaveLength(1);
    expect((officeCalls[0].resourceSpans as unknown[]).length).toBe(2);
    expect(body.logsInserted).toBe(2);
    expect(firstTelemetry).toEqual(['cowork']);
  });

  it('a mixed request passes on only the Office resources', async () => {
    const { status } = await post({ resourceSpans: [resourceSpan('claude-code'), resourceSpan('office-agent'), resourceSpan('other')] });
    expect(status).toBe(200);
    expect((officeCalls[0].resourceSpans as unknown[]).map(serviceOf)).toEqual(['office-agent']);
  });

  it('spans with no Office resource are ignored, never stored', async () => {
    const { status, body } = await post({ resourceSpans: [resourceSpan('claude-code')] });
    expect(status).toBe(200);
    expect(officeCalls).toHaveLength(0);
    expect(body.errors).toEqual(['Spans ignored for service.name: claude-code']);
  });
});
