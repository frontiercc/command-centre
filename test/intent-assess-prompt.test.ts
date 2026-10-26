// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { INTENT_SYSTEM_PROMPT } from '../lib/intent/assess';

describe('INTENT_SYSTEM_PROMPT — multilingual input, pinned English output', () => {
  it('states the message may be in any language, Portuguese included', () => {
    expect(INTENT_SYSTEM_PROMPT).toMatch(/any language/i);
    expect(INTENT_SYSTEM_PROMPT).toMatch(/Portuguese/);
  });
  it('pins the response language to English regardless of input', () => {
    expect(INTENT_SYSTEM_PROMPT).toMatch(/respond in English|response in English/i);
  });
  it('keeps matched evidence verbatim in the original language', () => {
    expect(INTENT_SYSTEM_PROMPT).toMatch(/original language/i);
  });
  it('names LGPD alongside GDPR in the risk framing', () => {
    expect(INTENT_SYSTEM_PROMPT).toContain('LGPD');
    expect(INTENT_SYSTEM_PROMPT).toContain('GDPR');
  });
});
