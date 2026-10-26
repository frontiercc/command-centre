// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Request body size limits. Next.js App
// Router route handlers impose no limit of their own, so one enormous request
// could be read whole into memory and take a hub down. Limits follow common
// defaults: 1 MB for ordinary JSON endpoints (nginx, Next's Pages router and
// Server Actions all default to 1 MB) and 50 MB for telemetry ingest (the
// OpenTelemetry Collector's own receiver accepts 20 MiB per request, and our
// collector combines several requests into one batch; the worst realistic
// batch measured from live counts is ~18 MB).
//
// Layers: middleware refuses a declared Content-Length over the limit
// (bodyLimitFor + 413). For a body with no declared length (chunked), Next.js
// itself cuts it off at experimental.middlewareClientMaxBodySize (next.config.mjs,
// set to 50 MB) before the route sees it, so an oversized chunked body arrives
// truncated and fails to parse (400). readJsonLimited() stopping at the limit is
// the backstop for any path that does not go through middleware.

export const OPEN_ROUTE_BODY_LIMIT = 1024 * 1024; // 1 MB
export const INGEST_BODY_LIMIT = 50 * 1024 * 1024; // 50 MB
/** Ingest requests above this are logged, to learn the real size distribution. */
export const INGEST_LOG_OVER = 5 * 1024 * 1024; // 5 MB

const INGEST_PREFIXES = ['/api/otel/'];
// Reachable without a session or token: their genuine bodies are a few hundred bytes.
const OPEN_ROUTES = [
  '/api/errors/log', '/api/admin/login', '/api/admin/logout', '/api/admin/setup',
  '/api/admin/forgot-password', '/api/admin/reset-password', '/api/admin/mfa/verify', '/api/auth/sso/',
];

/** The body limit for a path, or null where no limit applies yet (authenticated routes). */
export function bodyLimitFor(pathname: string): number | null {
  if (INGEST_PREFIXES.some(p => pathname.startsWith(p))) return INGEST_BODY_LIMIT;
  if (OPEN_ROUTES.some(p => pathname === p || pathname.startsWith(p.endsWith('/') ? p : `${p}/`))) return OPEN_ROUTE_BODY_LIMIT;
  return null;
}

export class BodyTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`Request body exceeds ${limit} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

/** Read the body as text, refusing once it passes `limit` bytes. */
export async function readTextLimited(request: Request, limit: number): Promise<{ text: string; bytes: number }> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLargeError(limit);
  if (!request.body) return { text: '', bytes: 0 };
  const reader = request.body.getReader();
  // Decode as the chunks arrive (stream: true keeps a multi-byte character split
  // across chunks intact), so a large body is never held twice as bytes.
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError(limit);
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return { text: parts.join(''), bytes };
}

/** Read and parse JSON with a size limit. A bad body throws SyntaxError, as request.json() does.
 *  Untyped by default, like request.json(), so it drops in where that was used. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readJsonLimited<T = any>(request: Request, limit: number): Promise<{ value: T; bytes: number }> {
  const { text, bytes } = await readTextLimited(request, limit);
  return { value: JSON.parse(text) as T, bytes };
}
