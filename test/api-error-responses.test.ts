// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Error responses never carry an exception's text to the caller (readiness
// review). The helper logs the detail and returns fixed text; the
// tripwire below catches the commonest way raw text used to leak.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { errorResponse, GENERIC_ERROR_MESSAGE, safeComplianceResult, sanitizeErrors } from '@/lib/api/errors';

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === 'route.ts') out.push(p);
  }
  return out;
}

describe('errorResponse', () => {
  it('logs the detail and returns fixed text only', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = errorResponse('test', new Error('relation "secret_table" does not exist'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: GENERIC_ERROR_MESSAGE });
    expect(JSON.stringify(body)).not.toContain('secret_table');
    expect(String(log.mock.calls[0]?.join(' '))).toContain('secret_table');
    log.mockRestore();
  });

  it('keeps a chosen status, message and extra fields', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = errorResponse('test', new Error('boom'), { status: 200, message: 'Hint', extra: { models: [] } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: [], error: 'Hint' });
  });
});

// Our own error classes whose messages are fixed text written in our code,
// filtered by type before they are returned.
const SAFE = new Set([
  'app/api/export/trends/route.ts', // InvalidMetricError only
  'app/api/admin/identity-conflicts/[id]/route.ts', // ConflictStateError only
]);

describe('library error lists', () => {
  it('sanitizeErrors logs each and returns one fixed line', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(sanitizeErrors('t', [])).toEqual([]);
    expect(sanitizeErrors('t', ['connect ECONNREFUSED 10.0.0.5:5432', 'relation "x" does not exist'])).toEqual(['2 errors. Details are in the server log.']);
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });

  it('safeComplianceResult replaces the nested chat and activity errors', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = safeComplianceResult('t', { skipped: false, chat: { chatsProcessed: 1, errors: ['401 invalid x-api-key'] }, activity: { activities: 0, errors: [] } });
    expect(JSON.stringify(r)).not.toContain('x-api-key');
    expect(r.chat?.errors).toEqual(['1 error. Details are in the server log.']);
    expect(r.activity?.errors).toEqual([]);
  });
});

describe('route error tripwire', () => {
  it('no route puts an exception message directly into a JSON response', () => {
    const root = path.join(process.cwd(), 'app', 'api');
    const hits: string[] = [];
    for (const f of walk(root)) {
      const rel = path.relative(process.cwd(), f).replace(/\\/g, '/');
      if (SAFE.has(rel)) continue;
      const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
      // Variables holding an exception's text, e.g. `const message = err instanceof Error ? err.message : String(err)`.
      const tainted = new Set<string>();
      for (const line of lines) {
        const m = line.match(/(?:const|let)\s+(\w+)\s*=\s*.*\b(err|error|e)(\.message|\s+instanceof\s+Error)/);
        if (m) tainted.add(m[1]);
      }
      lines.forEach((line, i) => {
        const direct = /NextResponse\.json\(.*\b(err|error|e)\.message/.test(line) || /NextResponse\.json\(.*String\((err|error|e)\)/.test(line)
          || /NextResponse\.json\(\{\s*error:\s*result\.error\b/.test(line); // a library result's error text passed straight through
        const viaVar = /NextResponse\.json\(/.test(line)
          && [...tainted].some(v => new RegExp(`(:\\s*|\\[\\s*|\\{\\s*)${v}\\b`).test(line));
        if (direct || viaVar) hits.push(`${rel}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
