// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Claude subagents: the built-in/custom rule, the ingest label guard and the
// spend share. Pure, no database.
import { describe, it, expect } from 'vitest';
import { classifySubagent, spendShare } from '@/lib/subagents/shared';
import { subagentLabel, SUBAGENT_LABEL_MAX, SUBAGENT_LAUNCH_TOOLS } from '@/lib/otel/subagent';

describe('classifySubagent', () => {
  it('trusts query_source when the client sends it', () => {
    expect(classifySubagent('Explore', 'agent:builtin:Explore')).toEqual({ kind: 'built_in', source: 'built_in', plugin: null });
    expect(classifySubagent('reviewer', 'agent:custom')).toEqual({ kind: 'custom', source: 'own', plugin: null });
  });

  it('a custom definition that shares a built-in name stays custom when query_source says so', () => {
    expect(classifySubagent('plan', 'agent:custom').kind).toBe('custom');
  });

  it('falls back to the built-in list when there is no query_source (Cowork launches)', () => {
    expect(classifySubagent('general-purpose', null).kind).toBe('built_in');
    expect(classifySubagent('Explore', undefined).kind).toBe('built_in');
    expect(classifySubagent('claim-verifier', null).kind).toBe('custom');
  });

  it('names the plugin for a namespaced subagent', () => {
    expect(classifySubagent('pr-review-toolkit:code-reviewer', 'agent:custom'))
      .toEqual({ kind: 'custom', source: 'plugin', plugin: 'pr-review-toolkit' });
  });

  it('marks the redacted name "custom" as withheld', () => {
    expect(classifySubagent('custom', 'agent:custom')).toEqual({ kind: 'custom', source: 'withheld', plugin: null });
  });
});

describe('subagentLabel', () => {
  it('keeps a trimmed, non-empty string', () => {
    expect(subagentLabel('  Explore ')).toBe('Explore');
  });
  it('drops empty and non-string values', () => {
    expect(subagentLabel('')).toBeNull();
    expect(subagentLabel('   ')).toBeNull();
    expect(subagentLabel(undefined)).toBeNull();
    expect(subagentLabel(42)).toBeNull();
    expect(subagentLabel({ subagent_type: 'x' })).toBeNull();
  });
  it('caps a long value', () => {
    expect(subagentLabel('a'.repeat(500))).toHaveLength(SUBAGENT_LABEL_MAX);
  });
  it('recognises both launch tool names', () => {
    expect(SUBAGENT_LAUNCH_TOOLS.has('Agent')).toBe(true);
    expect(SUBAGENT_LAUNCH_TOOLS.has('Task')).toBe(true);
    expect(SUBAGENT_LAUNCH_TOOLS.has('Bash')).toBe(false);
  });
});

describe('spendShare', () => {
  it('is null without both figures or with a zero total', () => {
    expect(spendShare(null, 10)).toBeNull();
    expect(spendShare(1, null)).toBeNull();
    expect(spendShare(1, 0)).toBeNull();
  });
  it('divides', () => {
    expect(spendShare(2.5, 10)).toBeCloseTo(0.25, 9);
  });
});
