// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The ingest route's status codes. The
// collector treats 500 as permanent and deletes the batch, but retries 503, so
// a request-level fault answers 503; a body that is not JSON answers 400.
// Every failure is recorded in error_events. No database — receivers mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const failures: Array<{ source: string; context: Record<string, unknown> }> = [];
let coworkThrows = false;

vi.mock('@/lib/auth/ingest-auth', () => ({
  authenticateIngest: async () => ({ authenticated: true, isCollector: true, agentId: null }),
}));
vi.mock('@/lib/auth/rate-limit', () => ({ isRateLimited: () => false }));
vi.mock('@/lib/otel/code-receiver', () => ({ processCodeOtlpLogs: async () => ({ processed: 0, skipped: 0, errors: [] }) }));
vi.mock('@/lib/otel/code-metrics-receiver', () => ({ processCodeOtlpMetrics: async () => ({ processed: 0, skipped: 0, errors: [] }) }));
vi.mock('@/lib/otel/cowork-receiver', () => ({
  processOtlpLogs: async () => {
    if (coworkThrows) throw new Error('connect ECONNREFUSED database');
    return { logsInserted: 1, skipped: 0, usersCreated: 0, sessionsCreated: 0, alertsFired: 0, errors: [] };
  },
}));
vi.mock('@/lib/otel/ingest-failure', () => ({
  recordIngestFailure: async (source: string, _message: string, context: Record<string, unknown>) => { failures.push({ source, context }); },
}));

const coworkBody = JSON.stringify({ resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'cowork' } }] }, scopeLogs: [] }] });

async function post(body: string) {
  const { POST } = await import('@/app/api/otel/ingest/route');
  return POST(new NextRequest('http://localhost/api/otel/ingest', { method: 'POST', headers: { 'content-type': 'application/json' }, body }));
}

beforeEach(() => { failures.length = 0; coworkThrows = false; });

describe('OTel ingest route status codes', () => {
  it('a request-level fault answers 503 (retryable) and is recorded', async () => {
    coworkThrows = true;
    const res = await post(coworkBody);
    expect(res.status).toBe(503);
    expect(failures).toEqual([{ source: 'otel-ingest', context: { status: 503, collector: true } }]);
  });

  it('a body that is not JSON answers 400 (permanent) and is recorded', async () => {
    const res = await post('{not json');
    expect(res.status).toBe(400);
    expect(failures[0].context.status).toBe(400);
  });

  it('an oversized body answers 413 (permanent, never the retryable 503) and is recorded', async () => {
    const { POST } = await import('@/app/api/otel/ingest/route');
    const res = await POST(new NextRequest('http://localhost/api/otel/ingest', {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(51 * 1024 * 1024) }, body: coworkBody,
    }));
    expect(res.status).toBe(413);
    expect(failures[0].context.status).toBe(413);
  });

  it('a large but genuine body (6 MB) is accepted', async () => {
    const pad = 'x'.repeat(6 * 1024 * 1024);
    const big = JSON.stringify({ resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'cowork' } }] }, scopeLogs: [], pad }] });
    const res = await post(big);
    expect(res.status).toBe(200);
    expect(failures).toHaveLength(0);
  });

  it('a healthy request still answers 200 and records nothing', async () => {
    const res = await post(coworkBody);
    expect(res.status).toBe(200);
    expect(failures).toHaveLength(0);
  });

  it('traces are refused: a spans-only request answers 400', async () => {
    const res = await post(JSON.stringify({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [] }] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing resourceLogs or resourceMetrics' });
  });
});
