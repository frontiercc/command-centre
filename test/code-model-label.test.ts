// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { formatModelLabel } from '@/lib/pulse/code/model-label';

describe('formatModelLabel', () => {
  it('labels a Bedrock CRIS-decorated model as an estimate', () => {
    expect(formatModelLabel('us.anthropic.claude-opus-4-6-v1')).toEqual({
      label: 'Claude Opus 4.6',
      provider: 'bedrock',
      estimated: true,
    });
  });

  it('labels a Vertex @-version model as an estimate', () => {
    expect(formatModelLabel('claude-sonnet-4-5@20250929')).toEqual({
      label: 'Claude Sonnet 4.5',
      provider: 'vertex',
      estimated: true,
    });
  });

  it('labels a plain Anthropic date-suffixed model as measured', () => {
    expect(formatModelLabel('claude-haiku-4-5-20251001')).toEqual({
      label: 'Claude Haiku 4.5',
      provider: 'anthropic',
      estimated: false,
    });
  });

  it('does not read a date suffix as a minor version on a single-number model', () => {
    expect(formatModelLabel('claude-sonnet-5-20260101').label).toBe('Claude Sonnet 5');
  });

  it('labels a plain Anthropic model with no date suffix as measured', () => {
    expect(formatModelLabel('claude-sonnet-4-6')).toEqual({
      label: 'Claude Sonnet 4.6',
      provider: 'anthropic',
      estimated: false,
    });
  });

  it('strips the Bedrock global routing prefix', () => {
    expect(formatModelLabel('global.anthropic.claude-sonnet-4-6')).toEqual({
      label: 'Claude Sonnet 4.6',
      provider: 'bedrock',
      estimated: true,
    });
  });

  it('strips the Bedrock -v1:0 version suffix', () => {
    expect(formatModelLabel('anthropic.claude-haiku-4-5-20251001-v1:0')).toEqual({
      label: 'Claude Haiku 4.5',
      provider: 'bedrock',
      estimated: true,
    });
  });

  it('falls back to the raw string for unknown shapes', () => {
    expect(formatModelLabel('mystery-model-9000')).toEqual({
      label: 'mystery-model-9000',
      provider: 'anthropic',
      estimated: false,
    });
  });

  it('falls back to the raw string for an empty model', () => {
    expect(formatModelLabel('')).toEqual({
      label: '',
      provider: 'anthropic',
      estimated: false,
    });
  });
});
