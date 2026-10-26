// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { thinkingOff } from '@/lib/anthropic/thinking';

describe('thinkingOff', () => {
  it('sends disabled to models that accept it', () => {
    for (const m of ['claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-haiku-5-5', 'claude-opus-4-8', 'us.anthropic.claude-sonnet-5-v1']) {
      expect(thinkingOff(m)).toEqual({ thinking: { type: 'disabled' } });
    }
  });

  it('sends between_tools to Sonnet 5.5, where disabled is a 400', () => {
    expect(thinkingOff('claude-sonnet-5-5')).toEqual({ thinking: { type: 'between_tools' } });
  });

  it('leaves thinking out and lowers effort where thinking cannot be turned off', () => {
    for (const m of ['claude-opus-5-5', 'claude-fable-5', 'claude-fable-5-1']) {
      expect(thinkingOff(m)).toEqual({ effort: 'low' });
    }
  });
});
