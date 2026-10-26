// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Request body size limits.
import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import {
  bodyLimitFor, readJsonLimited, readTextLimited, BodyTooLargeError,
  INGEST_BODY_LIMIT, OPEN_ROUTE_BODY_LIMIT,
} from '@/lib/api/body';
import { middleware } from '../middleware';

/** A POST whose body arrives as a stream with no Content-Length (chunked). */
function streamed(bytes: number): Request {
  const chunk = new Uint8Array(64 * 1024).fill(0x61);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= bytes) { c.close(); return; }
      const n = Math.min(chunk.byteLength, bytes - sent);
      c.enqueue(chunk.subarray(0, n)); sent += n;
    },
  });
  return new Request('http://hub.example.com/api/errors/log', { method: 'POST', body, duplex: 'half' } as RequestInit);
}

describe('bodyLimitFor', () => {
  it('50 MB for telemetry ingest, 1 MB for open routes, none elsewhere', () => {
    expect(bodyLimitFor('/api/otel/ingest')).toBe(INGEST_BODY_LIMIT);
    expect(bodyLimitFor('/api/cowork/ingest')).toBeNull(); // retired agent ingest route
    expect(bodyLimitFor('/api/errors/log')).toBe(OPEN_ROUTE_BODY_LIMIT);
    expect(bodyLimitFor('/api/admin/login')).toBe(OPEN_ROUTE_BODY_LIMIT);
    expect(bodyLimitFor('/api/auth/sso/callback')).toBe(OPEN_ROUTE_BODY_LIMIT);
    expect(bodyLimitFor('/api/use-cases/extract')).toBeNull(); // authenticated file uploads unaffected
    expect(bodyLimitFor('/api/admin/login-history')).toBeNull(); // prefix match needs a boundary
  });
});

describe('readJsonLimited / readTextLimited', () => {
  it('reads a normal body', async () => {
    const r = new Request('http://x/api/otel/ingest', { method: 'POST', body: JSON.stringify({ resourceLogs: [] }) });
    const { value, bytes } = await readJsonLimited(r, INGEST_BODY_LIMIT);
    expect(value).toEqual({ resourceLogs: [] });
    expect(bytes).toBe(JSON.stringify({ resourceLogs: [] }).length);
  });

  it('refuses a declared length over the limit without reading', async () => {
    const r = new Request('http://x/api/errors/log', { method: 'POST', body: '{}', headers: { 'content-length': String(OPEN_ROUTE_BODY_LIMIT + 1) } });
    await expect(readTextLimited(r, OPEN_ROUTE_BODY_LIMIT)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it('stops a streamed body with no length once it passes the limit', async () => {
    await expect(readTextLimited(streamed(OPEN_ROUTE_BODY_LIMIT + 10), OPEN_ROUTE_BODY_LIMIT)).rejects.toBeInstanceOf(BodyTooLargeError);
    const ok = await readTextLimited(streamed(OPEN_ROUTE_BODY_LIMIT), OPEN_ROUTE_BODY_LIMIT);
    expect(ok.bytes).toBe(OPEN_ROUTE_BODY_LIMIT); // exactly at the limit is allowed
  });

  it('a multi-byte character split across chunks decodes intact', async () => {
    const bytes = new TextEncoder().encode('{"p":"café—日本"}');
    const cut = bytes.indexOf(0xc3) + 1; // split inside the two-byte "é"
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.slice(0, cut)); c.enqueue(bytes.slice(cut)); c.close(); } });
    const r = new Request('http://x/api/otel/ingest', { method: 'POST', body, duplex: 'half' } as RequestInit);
    expect((await readJsonLimited(r, INGEST_BODY_LIMIT)).value).toEqual({ p: 'café—日本' });
  });

  it('a malformed body still throws SyntaxError, like request.json()', async () => {
    const r = new Request('http://x/api/otel/ingest', { method: 'POST', body: '{not json' });
    await expect(readJsonLimited(r, INGEST_BODY_LIMIT)).rejects.toBeInstanceOf(SyntaxError);
  });
});

describe('middleware body limit', () => {
  const mk = (path: string, len: number) => new NextRequest(`http://hub.example.com${path}`, {
    method: 'POST', headers: { host: 'hub.example.com', 'content-length': String(len) },
  });
  it('413 for a declared body over the route limit', () => {
    expect(middleware(mk('/api/otel/ingest', INGEST_BODY_LIMIT + 1)).status).toBe(413);
    expect(middleware(mk('/api/errors/log', OPEN_ROUTE_BODY_LIMIT + 1)).status).toBe(413);
  });
  it('a body within the limit carries on (telemetry ingest passes through to its route)', () => {
    expect(middleware(mk('/api/otel/ingest', 10 * 1024 * 1024)).status).toBe(200);
  });
});
