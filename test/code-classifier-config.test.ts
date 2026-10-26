// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getConfigValueMock = vi.fn();
vi.mock('@/lib/config', () => ({
  getConfigValue: (key: string) => getConfigValueMock(key),
}));

import {
  DEFAULT_CODE_CLASSIFIER_CONFIG,
  buildCodeClassifierSystemMessage,
  getCodeClassifierConfig,
} from '@/lib/pulse/code/tier-config';

beforeEach(() => {
  getConfigValueMock.mockReset();
});

describe('buildCodeClassifierSystemMessage', () => {
  it('default config reproduces the current rubric content', () => {
    const p = buildCodeClassifierSystemMessage(DEFAULT_CODE_CLASSIFIER_CONFIG);
    // tier meanings preserved
    expect(p).toContain('single-step or conversational');
    expect(p).toContain('frontier delegation');
    // all 8 work types present
    for (const w of ['feature', 'bugfix', 'refactor', 'testing', 'documentation', 'infrastructure', 'exploration', 'other']) {
      expect(p).toContain(w);
    }
    // signals guidance + JSON output contract
    expect(p).toContain('tool-actions-to-prompts');
    expect(p).toContain('"session_id"');
  });

  it('reflects edits to a tier name/description and a new work type', () => {
    const edited = structuredClone(DEFAULT_CODE_CLASSIFIER_CONFIG);
    edited.tiers.tier2.description = 'CUSTOM TIER TWO TEXT';
    edited.workTypes.push({ name: 'spike', description: 'timeboxed investigation' });
    const p = buildCodeClassifierSystemMessage(edited);
    expect(p).toContain('CUSTOM TIER TWO TEXT');
    expect(p).toContain('spike');
  });

  it('includes the confidence-threshold clause', () => {
    const p = buildCodeClassifierSystemMessage({ ...DEFAULT_CODE_CLASSIFIER_CONFIG, confidenceThreshold: 0.55 });
    expect(p).toContain('0.55');
  });
});

describe('getCodeClassifierConfig — shape guard', () => {
  it('falls back to the default when config is unset', async () => {
    getConfigValueMock.mockReturnValue('');
    const cfg = await getCodeClassifierConfig();
    expect(cfg).toEqual(DEFAULT_CODE_CLASSIFIER_CONFIG);
  });

  it('falls back to the default on valid JSON with the wrong shape ({"foo":1})', async () => {
    getConfigValueMock.mockReturnValue(JSON.stringify({ foo: 1 }));
    const cfg = await getCodeClassifierConfig();
    expect(cfg).toEqual(DEFAULT_CODE_CLASSIFIER_CONFIG);
  });

  it('falls back to the default on valid JSON with empty tiers/workTypes ({"tiers":{},"workTypes":[]})', async () => {
    getConfigValueMock.mockReturnValue(JSON.stringify({ tiers: {}, workTypes: [] }));
    const cfg = await getCodeClassifierConfig();
    expect(cfg).toEqual(DEFAULT_CODE_CLASSIFIER_CONFIG);
  });

  it('falls back to the default on malformed JSON', async () => {
    getConfigValueMock.mockReturnValue('{not valid json');
    const cfg = await getCodeClassifierConfig();
    expect(cfg).toEqual(DEFAULT_CODE_CLASSIFIER_CONFIG);
  });

  it('returns the parsed config when the shape is valid', async () => {
    const valid = structuredClone(DEFAULT_CODE_CLASSIFIER_CONFIG);
    valid.tiers.tier2.name = 'Custom Tier 2';
    getConfigValueMock.mockReturnValue(JSON.stringify(valid));
    const cfg = await getCodeClassifierConfig();
    expect(cfg.tiers.tier2.name).toBe('Custom Tier 2');
  });
});
