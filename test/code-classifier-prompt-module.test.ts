// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { buildCodeClassifierSystemMessage as fromPrompt, DEFAULT_CODE_CLASSIFIER_CONFIG as DEF_PROMPT } from '@/lib/pulse/code/classifier-prompt';
import { buildCodeClassifierSystemMessage as fromTierConfig, DEFAULT_CODE_CLASSIFIER_CONFIG as DEF_TIER } from '@/lib/pulse/code/tier-config';

describe('classifier-prompt client-safe module', () => {
  it('builds identical output whether imported from classifier-prompt or the tier-config re-export', () => {
    expect(fromPrompt(DEF_PROMPT)).toBe(fromTierConfig(DEF_TIER));
  });
  it('the default builds a prompt containing the tier descriptions, all work types and the signals line', () => {
    const p = fromPrompt(DEF_PROMPT);
    expect(p).toContain(DEF_PROMPT.tiers.tier1.description);
    for (const w of DEF_PROMPT.workTypes) expect(p).toContain(w.name);
    expect(p).toContain('Judge the session as a whole');
    expect(p).toContain('"session_id"');
  });
  it('classifier-prompt module does not import the server config reader', async () => {
    const src = await import('node:fs').then(fs => fs.readFileSync('lib/pulse/code/classifier-prompt.ts', 'utf8'));
    expect(src).not.toContain("@/lib/config");
  });
});
