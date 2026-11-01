// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Use case lists and surfaces named by product: Work and Code take in
// ChatGPT and Codex once OpenAI is connected.
import { describe, it, expect } from 'vitest';
import { surfaceLabels, labelForUseCaseSurface, groupDeptBoxes } from '@/lib/usecases/dept-boxes';

describe('use case labels by product', () => {
  it('names the lists by what is connected', () => {
    expect(surfaceLabels(null)).toEqual({ cowork: 'Cowork', code: 'Claude Code' });
    expect(surfaceLabels({ claude: true, openai: false })).toEqual({ cowork: 'Cowork', code: 'Claude Code' });
    expect(surfaceLabels({ claude: true, openai: true })).toEqual({ cowork: 'Cowork and ChatGPT', code: 'Claude Code and Codex' });
    expect(surfaceLabels({ claude: false, openai: true })).toEqual({ cowork: 'ChatGPT', code: 'Codex' });
  });

  it('labels a use case surface', () => {
    expect(labelForUseCaseSurface('chat', { claude: true, openai: true })).toBe('Claude Chat');
    expect(labelForUseCaseSurface('chat', null)).toBe('Chat');
    expect(labelForUseCaseSurface('code', { claude: false, openai: true })).toBe('Codex');
  });

  it('department boxes carry the labels given', () => {
    const boxes = groupDeptBoxes(
      [{ department: 'Sales', surface: 'cowork' }, { department: 'Sales', surface: 'code' }] as never,
      surfaceLabels({ claude: true, openai: true }),
    );
    expect(boxes[0].groups.map(g => g.label)).toEqual(['Cowork and ChatGPT', 'Claude Code and Codex']);
  });
});
