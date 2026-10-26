// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import {
  buildSessionDigest,
  parseClassifierResponse,
  normaliseWorkType,
  WORK_TYPES,
  type SessionDigestRow,
} from '@/lib/pulse/code/classifier';
import { buildCodeClassifierSystemMessage, DEFAULT_CODE_CLASSIFIER_CONFIG } from '@/lib/pulse/code/tier-config';

const ROW: SessionDigestRow = {
  session_id: 's1',
  user_id: 'user-1',
  repo: 'claude-command-centre',
  git_branch: 'feature/code-pulse',
  first_at: 1_000_000,
  last_at: 1_000_000 + 5400, // 90 min
  user_msg_count: 12,
  assistant_turns: 40,
  tool_use_count: 95,
  error_count: 3,
  commit_count: 4,
  input_tokens: 500_000,
  output_tokens: 60_000,
  skills_json: JSON.stringify([{ name: 'code-review', invocation_type: 'agent_chained' }]),
  mcp_json: JSON.stringify(['github']),
  models_json: JSON.stringify({ 'claude-fable-5': { input: 1, output: 1, cache_creation: 0, cache_read: 0 } }),
};

describe('buildSessionDigest', () => {
  it('renders the full metadata digest', () => {
    const d = buildSessionDigest(ROW, null);
    expect(d).toContain('session_id: s1');
    expect(d).toContain('repo: claude-command-centre (branch: feature/code-pulse)');
    expect(d).toContain('duration_minutes: 90');
    expect(d).toContain('human_prompts: 12');
    expect(d).toContain('tool_actions: 95');
    expect(d).toContain('git_commits_made: 4');
    expect(d).toContain('skills_invoked: code-review');
    expect(d).toContain('connectors_used: github');
    expect(d).toContain('models: claude-fable-5');
    expect(d).not.toContain('first_prompt');
  });

  it('includes a truncated first prompt only when provided', () => {
    const d = buildSessionDigest(ROW, 'x'.repeat(500));
    const line = d.split('\n').find(l => l.startsWith('first_prompt:'))!;
    expect(line.length).toBeLessThanOrEqual('first_prompt: '.length + 200);
  });

  it('survives malformed JSON columns', () => {
    const d = buildSessionDigest({ ...ROW, skills_json: '{broken', mcp_json: null, models_json: 'nope' }, null);
    expect(d).toContain('skills_invoked: none');
    expect(d).toContain('connectors_used: none');
    expect(d).toContain('models: unknown');
  });
});

describe('system message', () => {
  it('mentions every work type and demands bare JSON', () => {
    const sys = buildCodeClassifierSystemMessage(DEFAULT_CODE_CLASSIFIER_CONFIG);
    for (const wt of WORK_TYPES) expect(sys).toContain(wt);
    expect(sys).toContain('ONLY a JSON array');
  });
});

describe('normaliseWorkType', () => {
  it('preserves a configured/renamed work type not in the static WORK_TYPES set', () => {
    const accepted = ['feature', 'bugfix', 'spike']; // 'spike' is admin-added, not a static WORK_TYPES member
    expect(normaliseWorkType('spike', accepted)).toBe('spike');
  });

  it('coerces a value outside the accepted set to other', () => {
    const accepted = ['feature', 'bugfix', 'spike'];
    expect(normaliseWorkType('nonsense', accepted)).toBe('other');
  });

  it('still accepts the static defaults when passed as the accepted set', () => {
    for (const wt of WORK_TYPES) {
      expect(normaliseWorkType(wt, WORK_TYPES as readonly string[])).toBe(wt);
    }
    expect(normaliseWorkType('not-a-real-type', WORK_TYPES as readonly string[])).toBe('other');
  });
});

describe('parseClassifierResponse', () => {
  const items = [{ session_id: 's1', work_type: 'feature', tier: 2, confidence: 0.9 }];

  it('parses a bare JSON array', () => {
    expect(parseClassifierResponse(JSON.stringify(items))).toEqual(items);
  });

  it('parses a fenced response', () => {
    expect(parseClassifierResponse('```json\n' + JSON.stringify(items) + '\n```')).toEqual(items);
  });

  it('parses a response with a prose preamble', () => {
    expect(parseClassifierResponse('Here are the classifications:\n' + JSON.stringify(items))).toEqual(items);
  });

  it('returns [] for garbage and non-arrays', () => {
    expect(parseClassifierResponse('not json at all')).toEqual([]);
    expect(parseClassifierResponse('{"session_id": "s1"}')).toEqual([]);
  });
});
