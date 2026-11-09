// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * A Codex session's digest carries its real counts. code_session_stats has no
 * tool, failure, commit or model figures for a Codex session (they live in
 * codex_actions and codex_turns), so the classifier used to be told a Codex
 * session made no tool actions, no commits and no model calls. A Claude Code
 * session's digest must be exactly what it was. The Anthropic SDK is mocked
 * and the user message it receives is read back.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import { seedUserSql } from './helpers/seed';
import type { TestSql } from './helpers/sql';

vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn();
  return {
    default: vi.fn().mockImplementation(() => ({ messages: { create: mockCreate } })),
    __mockCreate: mockCreate,
  };
});

async function getMockCreate() {
  const mod = await import('@anthropic-ai/sdk');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mod as any).__mockCreate as ReturnType<typeof vi.fn>;
}

let sql: TestSql;
let cleanup: () => Promise<void>;
let classifier: typeof import('@/lib/pulse/code/classifier');

const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3600;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
  classifier = await import('@/lib/pulse/code/classifier');
  await seedUserSql(sql, 'user-1');
});

afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`DELETE FROM code_session_classifications; DELETE FROM code_session_stats; DELETE FROM cowork_messages;
    DELETE FROM codex_actions; DELETE FROM codex_turns;
    DELETE FROM config WHERE key IN ('anthropic_ai_api_key', 'code_pulse_enabled', 'code_classifier_enabled', 'code_classify_codex');`);
  await sql.run(`INSERT INTO config (key, value) VALUES ('anthropic_ai_api_key', 'sk-test-key')`);
  (await getMockCreate()).mockReset();
});

const CLAUDE_ROW = {
  session_id: 'claude-s1', user_id: 'user-1', repo: 'my-app', git_branch: 'main',
  first_at: NOW - 3 * HOUR, last_at: NOW - 2 * HOUR,
  user_msg_count: 4, assistant_turns: 11, tool_use_count: 23, error_count: 2, commit_count: 1,
  input_tokens: 1000, output_tokens: 200,
  skills_json: JSON.stringify([{ name: 'code-review', invocation_type: 'user_typed' }]),
  mcp_json: JSON.stringify(['github']),
  models_json: JSON.stringify({ 'claude-fable-5': { input: 1000, output: 200, cache_creation: 0, cache_read: 0 } }),
};

async function seedStats(r: typeof CLAUDE_ROW) {
  await sql.run(`INSERT INTO code_session_stats
      (session_id, user_id, repo, git_branch, first_at, last_at, user_msg_count, assistant_turns, tool_use_count,
       error_count, commit_count, input_tokens, output_tokens, skills_json, mcp_json, models_json, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [r.session_id, r.user_id, r.repo, r.git_branch, r.first_at, r.last_at, r.user_msg_count, r.assistant_turns, r.tool_use_count,
    r.error_count, r.commit_count, r.input_tokens, r.output_tokens, r.skills_json, r.mcp_json, r.models_json, NOW]);
}

async function seedCodexSession() {
  // As the aggregator writes a Codex session: prompts counted, nothing else.
  await seedStats({
    ...CLAUDE_ROW, session_id: 'codex:abc', repo: null as unknown as string, git_branch: null as unknown as string,
    user_msg_count: 3, assistant_turns: 0, tool_use_count: 0, error_count: 0, commit_count: 0,
    input_tokens: 0, output_tokens: 0, skills_json: '[]', mcp_json: '[]', models_json: '{}',
  });
  // 7 actions, 2 failed, commits 1 + 2 = 3.
  for (let i = 0; i < 7; i++) {
    await sql.run(`INSERT INTO codex_actions (id, user_id, session_id, tool_name, failed, commit_count, occurred_at)
      VALUES (?, 'user-1', 'codex:abc', 'shell', ?, ?, ?)`, [`a${i}`, i < 2 ? 1 : 0, i === 5 ? 1 : i === 6 ? 2 : 0, NOW - 2 * HOUR - i]);
  }
  // 4 turns over two models.
  for (const [id, model] of [['t1', 'gpt-5.3-codex'], ['t2', 'gpt-5.3-codex'], ['t3', 'gpt-5.3-codex'], ['t4', 'gpt-5.4']]) {
    await sql.run(`INSERT INTO codex_turns (id, user_id, session_id, model, started_at) VALUES (?, 'user-1', 'codex:abc', ?, ?)`,
      [id, model, NOW - 2 * HOUR]);
  }
}

function digestsSent(call: unknown[]): Map<string, string> {
  const body = call[0] as { messages: Array<{ content: string }> };
  const text = body.messages[0].content.replace(/^Classify these \d+ sessions:\n\n/, '');
  return new Map(text.split('\n\n---\n\n').map(d => [d.split('\n')[0].replace('session_id: ', ''), d]));
}

describe('Codex counts in the session classifier digest', () => {
  it('tells the classifier a Codex session\'s real actions, failures, commits and model calls', async () => {
    await seedCodexSession();
    await seedStats(CLAUDE_ROW);
    const create = await getMockCreate();
    create.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify([
      { session_id: 'codex:abc', work_type: 'feature', tier: 2, confidence: 0.8 },
      { session_id: 'claude-s1', work_type: 'bugfix', tier: 1, confidence: 0.7 },
    ]) }] });

    const result = await classifier.runCodeClassifierJob();
    expect(result.classified).toBe(2);
    const digests = digestsSent(create.mock.calls[0]);

    const codex = digests.get('codex:abc')!;
    expect(codex).toContain('human_prompts: 3');
    expect(codex).toContain('model_calls: 4');
    expect(codex).toContain('tool_actions: 7');
    expect(codex).toContain('failed_tool_actions: 2');
    expect(codex).toContain('git_commits_made: 3');
    const models = codex.split('\n').find(l => l.startsWith('models: '))!.replace('models: ', '').split(', ').sort();
    expect(models).toEqual(['gpt-5.3-codex', 'gpt-5.4']);

    // The Claude Code digest is byte-for-byte what it was before.
    expect(digests.get('claude-s1')).toBe(classifier.buildSessionDigest(CLAUDE_ROW, null));
  });

  it('leaves Claude Code rows untouched and does not regrade a classified Codex session', async () => {
    const client = await (await import('@/lib/db/client')).getTypedClient();
    const rows = [CLAUDE_ROW];
    const out = await classifier.withCodexCounts(client, rows);
    expect(out).toBe(rows); // no Codex session: the same array back

    await seedCodexSession();
    await sql.run(`INSERT INTO code_session_classifications
        (session_id, user_id, work_type, tier, confidence, classifier_model, status, error, classified_at, provisional)
      VALUES ('codex:abc', 'user-1', 'feature', 2, 0.8, 'claude-haiku-4-5-20251001', 'classified', NULL, ?, 0)`, [NOW - HOUR]);
    const create = await getMockCreate();
    const result = await classifier.runCodeClassifierJob();
    expect(result.selected).toBe(0);
    expect(create).not.toHaveBeenCalled();
  });

  it('a Codex session with no actions or turns reads zero and unknown models', async () => {
    await seedStats({
      ...CLAUDE_ROW, session_id: 'codex:empty', user_msg_count: 1, assistant_turns: 0, tool_use_count: 0,
      error_count: 0, commit_count: 0, models_json: '{}',
    });
    const client = await (await import('@/lib/db/client')).getTypedClient();
    const [row] = await classifier.withCodexCounts(client, [{ ...CLAUDE_ROW, session_id: 'codex:empty', models_json: '{}' }]);
    const d = classifier.buildSessionDigest(row, null);
    expect(d).toContain('tool_actions: 0');
    expect(d).toContain('model_calls: 0');
    expect(d).toContain('models: unknown');
  });
});
