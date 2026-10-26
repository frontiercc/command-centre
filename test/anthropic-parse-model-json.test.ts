// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { parseModelJson } from '@/lib/anthropic/constants';

describe('parseModelJson', () => {
  it('parses valid JSON normally', () => {
    const result = parseModelJson('{"reply":"hello","candidates":[]}');
    expect(result).toEqual({ reply: 'hello', candidates: [] });
  });

  it('parses JSON containing a literal newline inside a string value', () => {
    // Simulates the real bug: the model emits a raw newline INSIDE a JSON
    // string literal (long multi-paragraph reply), which is invalid per the
    // JSON spec and makes strict JSON.parse throw.
    const raw = '{"reply":"Paragraph one.\nParagraph two.","candidates":[]}';
    const result = parseModelJson(raw) as { reply: string; candidates: unknown[] };
    expect(result).not.toBeNull();
    expect(result.reply).toBe('Paragraph one.\nParagraph two.');
    expect(result.candidates).toEqual([]);
  });

  it('handles a literal tab and carriage return inside a string value', () => {
    const raw = '{"reply":"a\tb\rc","candidates":[]}';
    const result = parseModelJson(raw) as { reply: string };
    expect(result).not.toBeNull();
    expect(result.reply).toBe('a\tb\rc');
  });

  it('returns null for genuinely unparseable input', () => {
    expect(parseModelJson('not valid json at all')).toBeNull();
    expect(parseModelJson('{unterminated')).toBeNull();
  });

  it('leaves an already-escaped \\n inside a string value unchanged', () => {
    const raw = '{"reply":"line one\\nline two","candidates":[]}';
    const result = parseModelJson(raw) as { reply: string };
    expect(result).not.toBeNull();
    expect(result.reply).toBe('line one\nline two');
  });
});
