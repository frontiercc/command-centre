// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// POST /api/otel/ingest — a collector batch can carry MORE THAN ONE surface.
// The OTel collector's batch processor merges everything it received in a
// 2s window into ONE export request, so a request routinely holds a Cowork
// resource (service.name='cowork') AND a Claude Code resource
// (service.name='claude-code*') side by side. An earlier version of the route read
// the FIRST resource's service.name and handed the WHOLE request to that one
// receiver; each receiver skips resources that are not its own, so the other
// surface's events were silently dropped (no error, no log). Reproduced live
// on the Azure sandbox (whichever surface was sent first survived) and on
// localhost through a real collector (8 sent, 4 stored).
//
// The route must now split the request's resources by service.name, hand
// each group to its receiver, and merge the results. Single-surface requests
// keep EXACTLY the old behaviour (one receiver call, its result verbatim).
//
// Receivers are mocked here: this pins the ROUTING, not receiver internals
// (those have their own suites). Auth and rate limiting are mocked open.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

type Payload = Record<string, unknown>;
const coworkCalls: Payload[] = [];
const codeCalls: Payload[] = [];
const metricCalls: Payload[] = [];
const firstTelemetry: string[] = [];

vi.mock('@/lib/auth/ingest-auth', () => ({
  authenticateIngest: async () => ({ authenticated: true, isCollector: true, agentId: null }),
}));
vi.mock('@/lib/auth/rate-limit', () => ({ isRateLimited: () => false }));
vi.mock('@/lib/setup/first-telemetry', () => ({
  noteFirstTelemetry: async (product: string) => { firstTelemetry.push(product); },
}));
vi.mock('@/lib/otel/cowork-receiver', () => ({
  processOtlpLogs: async (payload: Payload) => {
    coworkCalls.push(payload);
    return { logsInserted: (payload.resourceLogs as unknown[]).length, skipped: 0, usersCreated: 0, sessionsCreated: 0, alertsFired: 0, errors: [] };
  },
}));
vi.mock('@/lib/otel/code-receiver', () => ({
  processCodeOtlpLogs: async (payload: Payload) => {
    codeCalls.push(payload);
    return { processed: (payload.resourceLogs as unknown[]).length, skipped: 0, errors: [] };
  },
}));
vi.mock('@/lib/otel/code-metrics-receiver', () => ({
  processCodeOtlpMetrics: async (payload: Payload) => {
    metricCalls.push(payload);
    return { processed: (payload.resourceMetrics as unknown[]).length, skipped: 0, errors: [] };
  },
}));

const str = (key: string, value: string) => ({ key, value: { stringValue: value } });
const resourceLog = (service: string, sessionId: string) => ({
  resource: { attributes: [str('service.name', service), str('user.email', 'u@x.test')] },
  scopeLogs: [{ logRecords: [{ timeUnixNano: '1750000000000000000',
    attributes: [str('event.name', 'claude_code.user_prompt'), str('session.id', sessionId), str('prompt', 'hi')] }] }],
});
const resourceMetric = (service: string) => ({
  resource: { attributes: [str('service.name', service)] },
  scopeMetrics: [{ metrics: [{ name: 'claude_code.lines_of_code.count', sum: { dataPoints: [] } }] }],
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

describe('POST /api/otel/ingest routes a mixed-surface batch to BOTH receivers', () => {
  beforeEach(() => { coworkCalls.length = 0; codeCalls.length = 0; metricCalls.length = 0; });

  it('cowork first, code second: each receiver gets only its own resources', async () => {
    const { status, body } = await post({ resourceLogs: [resourceLog('cowork', 'c1'), resourceLog('claude-code', 'k1')] });
    expect(status).toBe(200);
    expect(coworkCalls).toHaveLength(1);
    expect(codeCalls).toHaveLength(1);
    expect((coworkCalls[0].resourceLogs as unknown[]).map(serviceOf)).toEqual(['cowork']);
    expect((codeCalls[0].resourceLogs as unknown[]).map(serviceOf)).toEqual(['claude-code']);
    // Merged response carries both receivers' counts and no errors.
    expect(body.logsInserted).toBe(1);
    expect(body.processed).toBe(1);
    expect(body.errors).toEqual([]);
  });

  it('code first, cowork second: order does not decide who survives', async () => {
    const { status } = await post({ resourceLogs: [resourceLog('claude-code-desktop', 'k1'), resourceLog('cowork', 'c1')] });
    expect(status).toBe(200);
    expect((coworkCalls[0].resourceLogs as unknown[]).map(serviceOf)).toEqual(['cowork']);
    expect((codeCalls[0].resourceLogs as unknown[]).map(serviceOf)).toEqual(['claude-code-desktop']);
  });

  it('several resources of both kinds: every one reaches its receiver', async () => {
    await post({ resourceLogs: [
      resourceLog('cowork', 'c1'), resourceLog('claude-code', 'k1'),
      resourceLog('cowork', 'c2'), resourceLog('claude-code-desktop', 'k2'), resourceLog('cowork', 'c3'),
    ] });
    expect((coworkCalls[0].resourceLogs as unknown[]).length).toBe(3);
    expect((codeCalls[0].resourceLogs as unknown[]).length).toBe(2);
  });

  it('single-surface request keeps the old behaviour: one receiver, its result verbatim', async () => {
    const { body } = await post({ resourceLogs: [resourceLog('cowork', 'c1'), resourceLog('cowork', 'c2')] });
    expect(coworkCalls).toHaveLength(1);
    expect(codeCalls).toHaveLength(0);
    expect(body).toEqual({ logsInserted: 2, skipped: 0, usersCreated: 0, sessionsCreated: 0, alertsFired: 0, errors: [] });

    coworkCalls.length = 0; codeCalls.length = 0;
    const code = await post({ resourceLogs: [resourceLog('claude-code', 'k1')] });
    expect(coworkCalls).toHaveLength(0);
    expect(codeCalls).toHaveLength(1);
    expect(code.body).toEqual({ processed: 1, skipped: 0, errors: [] });
  });

  it('an unrecognised service.name is reported, and does not stop the recognised ones', async () => {
    const { status, body } = await post({ resourceLogs: [resourceLog('something-else', 'x1'), resourceLog('cowork', 'c1')] });
    expect(status).toBe(200);
    expect(coworkCalls).toHaveLength(1);
    expect(codeCalls).toHaveLength(0);
    expect(String(body.errors)).toContain('something-else');

    coworkCalls.length = 0;
    const only = await post({ resourceLogs: [resourceLog('something-else', 'x1')] });
    expect(coworkCalls).toHaveLength(0);
    expect(codeCalls).toHaveLength(0);
    expect(String(only.body.errors)).toContain('Unrecognised service.name');
  });

  it('metrics: a cowork resource ahead of a claude-code one no longer hides the Code metrics', async () => {
    const { status } = await post({ resourceMetrics: [resourceMetric('cowork'), resourceMetric('claude-code')] });
    expect(status).toBe(200);
    expect(metricCalls).toHaveLength(1);
    expect((metricCalls[0].resourceMetrics as unknown[]).map(serviceOf)).toEqual(['claude-code']);
  });
});

// The dashboard's "Get started" panel ticks Claude Code and Cowork off on their
// first real telemetry, marked here and nowhere else (sample data never passes
// through this route).
describe('POST /api/otel/ingest marks the first telemetry per product', () => {
  beforeEach(() => { firstTelemetry.length = 0; });

  it('marks each product only when its own resources arrive', async () => {
    await post({ resourceLogs: [resourceLog('cowork', 'c1')] });
    expect(firstTelemetry).toEqual(['cowork']);

    firstTelemetry.length = 0;
    await post({ resourceLogs: [resourceLog('claude-code', 'k1'), resourceLog('cowork', 'c1')] });
    expect(firstTelemetry.sort()).toEqual(['code', 'cowork']);

    firstTelemetry.length = 0;
    await post({ resourceMetrics: [resourceMetric('claude-code')] });
    expect(firstTelemetry).toEqual(['code']);
  });

  it('marks nothing for an unrecognised service or Cowork metrics', async () => {
    await post({ resourceLogs: [resourceLog('something-else', 'x1')] });
    await post({ resourceMetrics: [resourceMetric('cowork')] });
    expect(firstTelemetry).toEqual([]);
  });
});
