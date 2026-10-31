// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The OpenAI sync's record rules, with no database: which export records
// become prompts, which surface and source each takes, and the ids that make a
// repeated delivery a no-op. The end-to-end run is in openai-sync-pg.test.ts.
import { describe, it, expect } from 'vitest';
import { interpretRecord } from '@/lib/openai/sync';
import { parseJsonl } from '@/lib/openai/client';
import { isOpenAiSource, OPENAI_SOURCE_LABELS, surfaceLabel } from '@/lib/openai/sources';

const NOW = Date.parse('2026-10-20T12:00:00Z') / 1000;
const FLOORS = { cowork: NOW - 30 * 86400, code: NOW - 30 * 86400 };
const actor = { type: 'ACCOUNT_USER', user_id: 'user-1', user_email: 'pat@example.org' };

function chatMessage(over: Record<string, unknown> = {}, mode = 'chat') {
  return {
    event_id: 'evt-1',
    type: 'CONVERSATION_MESSAGE',
    timestamp: '2026-10-20T10:00:05.000000Z',
    actor,
    message: {
      id: 'msg-1',
      created_at: '2026-10-20T10:00:00.000000Z',
      author: { type: 'user', client_type: 'macos_app' },
      content: { type: 'text', value: 'Summarise the Q3 board pack.' },
      files: [{ id: 'file-1', name: 'board-pack.pdf' }],
    },
    conversation: { id: 'conv-1', mode },
    ...over,
  };
}

function codexLog(over: Record<string, unknown> = {}) {
  return {
    event_id: 'evt-c1',
    type: 'CODEX_LOG',
    timestamp: '2026-10-20T11:00:00.000000Z',
    actor,
    event_type: 'PROMPT_SENT',
    client_id: 'CODEX_CLI',
    workspace_id: 'ws-1',
    event_details: { detail_type: 'PROMPT_SENT', session_id: 'sess-1', prompt_text: 'Add pagination to the orders endpoint.', model: 'gpt-5.5-codex' },
    ...over,
  };
}

describe('interpretRecord', () => {
  it('stores a ChatGPT Chat user message with Cowork prompts', () => {
    const it = interpretRecord(chatMessage(), FLOORS);
    expect(it.kind).toBe('prompt');
    if (it.kind !== 'prompt') return;
    expect(it.row).toMatchObject({
      id: 'chatgpt:msg-1',
      sessionId: 'chatgpt:conv-1',
      source: 'chatgpt_chat',
      surface: 'cowork',
      messageType: 'cowork_user_message',
      email: 'pat@example.org',
      text: 'Summarise the Q3 board pack.',
      occurredAt: Date.parse('2026-10-20T10:00:00Z') / 1000,
      fileNames: ['board-pack.pdf'],
    });
  });

  it('marks a Work conversation as ChatGPT Work', () => {
    const it = interpretRecord(chatMessage({}, 'work'), FLOORS);
    expect(it.kind === 'prompt' && it.row.source).toBe('chatgpt_work');
  });

  it('keys an edited message on its message id, so the edit is a repeat', () => {
    const first = interpretRecord(chatMessage(), FLOORS);
    const edited = interpretRecord(chatMessage({ event_id: 'evt-2', timestamp: '2026-10-20T10:01:00Z' }), FLOORS);
    expect(first.kind === 'prompt' && edited.kind === 'prompt' && first.row.id === edited.row.id).toBe(true);
  });

  it('never stores an assistant reply', () => {
    const reply = chatMessage({ message: { id: 'msg-2', author: { type: 'assistant', model: 'gpt-5.5' }, content: { type: 'text', value: 'Here is a summary.' } } });
    expect(interpretRecord(reply, FLOORS)).toEqual({ kind: 'skip', reason: 'not_a_prompt' });
  });

  it('skips an empty prompt and non-text content', () => {
    expect(interpretRecord(chatMessage({ message: { id: 'm', author: { type: 'user' }, content: { type: 'text', value: '  ' } } }), FLOORS).kind).toBe('skip');
    expect(interpretRecord(chatMessage({ message: { id: 'm', author: { type: 'user' }, content: { type: 'user_instructions', value: 'Be brief' } } }), FLOORS).kind).toBe('skip');
  });

  it('skips a record with no single plain email', () => {
    expect(interpretRecord(chatMessage({ actor: { type: 'API_KEY', redacted_id: 'abc...wxyz' } }), FLOORS)).toEqual({ kind: 'skip', reason: 'no_person' });
    expect(interpretRecord(codexLog({ actor: { type: 'ACCOUNT_USER', user_email: 'a@x.example, b@x.example' } }), FLOORS)).toEqual({ kind: 'skip', reason: 'no_person' });
  });

  it('skips a record older than the floor for its surface', () => {
    const floors = { cowork: NOW, code: NOW - 30 * 86400 };
    expect(interpretRecord(chatMessage(), floors)).toEqual({ kind: 'skip', reason: 'too_old' });
    expect(interpretRecord(codexLog(), floors).kind).toBe('prompt');
  });

  it('stores a Codex prompt with Claude Code prompts', () => {
    const it = interpretRecord(codexLog(), FLOORS);
    expect(it.kind).toBe('prompt');
    if (it.kind !== 'prompt') return;
    expect(it.row).toMatchObject({
      id: 'codex:evt-c1',
      sessionId: 'codex:sess-1',
      source: 'codex',
      surface: 'code',
      messageType: 'code_user_message',
      model: 'gpt-5.5-codex',
      fileNames: [],
    });
  });

  it('skips ChatGPT Work prompts repeated in the Codex log', () => {
    for (const client of ['CODEX_WORK_WEB', 'CODEX_WORK_DESKTOP', 'CODEX_WORK_MOBILE']) {
      expect(interpretRecord(codexLog({ client_id: client }), FLOORS)).toEqual({ kind: 'skip', reason: 'work_in_codex_log' });
    }
  });

  it('stores only PROMPT_SENT from the Codex log', () => {
    for (const t of ['PROMPT_RESPONSE_RECEIVED', 'TOOL_CALL_COMPLETED', 'APP_MCP_CALL', 'PLUGIN_INSTALLED']) {
      expect(interpretRecord(codexLog({ event_type: t }), FLOORS).kind).toBe('skip');
    }
  });

  it('ignores record types this phase does not read', () => {
    expect(interpretRecord({ type: 'COSTS', event_id: 'x' }, FLOORS).kind).toBe('skip');
    expect(interpretRecord(null, FLOORS).kind).toBe('skip');
  });
});

describe('parseJsonl', () => {
  it('parses each line and counts lines that are not JSON', () => {
    const { records, badLines } = parseJsonl('{"a":1}\n\nnot json\n{"b":2}\n');
    expect(records).toEqual([{ a: 1 }, { b: 2 }]);
    expect(badLines).toBe(1);
  });
});

describe('OpenAI sources', () => {
  it('labels each source and recognises only those three', () => {
    expect(OPENAI_SOURCE_LABELS).toEqual({ chatgpt_chat: 'ChatGPT Chat', chatgpt_work: 'ChatGPT Work', codex: 'Codex' });
    expect(isOpenAiSource('codex')).toBe(true);
    expect(isOpenAiSource('otel')).toBe(false);
    expect(isOpenAiSource(null)).toBe(false);
  });

  it('labels the surface by product for OpenAI rows and leaves Claude rows as stored', () => {
    expect(surfaceLabel('cowork', 'chatgpt_chat')).toBe('chat');
    expect(surfaceLabel('cowork', 'chatgpt_work')).toBe('work');
    expect(surfaceLabel('code', 'codex')).toBe('codex');
    expect(surfaceLabel('cowork', 'otel')).toBe('cowork');
    expect(surfaceLabel('code', 'otel')).toBe('code');
    expect(surfaceLabel('chat', 'compliance')).toBe('chat');
  });
});
