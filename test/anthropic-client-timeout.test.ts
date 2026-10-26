// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Every Anthropic client carries a bounded timeout:
// the SDK default is 10 minutes and the scheduler runs jobs one after another, so
// one hung call would stall them all. Clients must come from createAnthropicClient.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createAnthropicClient, AI_CALL_TIMEOUT_MS, LONG_AI_CALL_TIMEOUT_MS } from '@/lib/anthropic/client';

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('Anthropic client timeouts', () => {
  it('no code outside lib/anthropic/client.ts constructs a client directly', () => {
    const root = process.cwd();
    const offenders = [...walk(path.join(root, 'app')), ...walk(path.join(root, 'lib'))]
      .filter(f => path.relative(root, f).replace(/\\/g, '/') !== 'lib/anthropic/client.ts')
      .filter(f => /new\s+Anthropic\s*\(/.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(root, f));
    expect(offenders).toEqual([]);
  });

  it('the helper sets a bounded timeout, and a longer one on request', () => {
    expect(createAnthropicClient('sk-test').timeout).toBe(AI_CALL_TIMEOUT_MS);
    expect(createAnthropicClient('sk-test', { timeoutMs: LONG_AI_CALL_TIMEOUT_MS }).timeout).toBe(LONG_AI_CALL_TIMEOUT_MS);
    expect(AI_CALL_TIMEOUT_MS).toBeLessThan(10 * 60 * 1000);
  });
});
