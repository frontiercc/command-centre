// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The use case session judge (use cases defined by the work),
// on Postgres with the Anthropic SDK mocked.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDatabase } from './helpers/db';
import type { TestSql } from './helpers/sql';

vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn();
  return {
    default: vi.fn().mockImplementation(() => ({ messages: { create: mockCreate } })),
    __mockCreate: mockCreate,
  };
});

let sql: TestSql;
let cleanup: () => Promise<void>;
let mockCreate: ReturnType<typeof vi.fn>;
let setConfigValue: typeof import('@/lib/config').setConfigValue;
let judge: typeof import('@/lib/usecases/session-judge');
let createUseCase: typeof import('@/lib/usecases/queries').createUseCase;
let updateUseCase: typeof import('@/lib/usecases/queries').updateUseCase;
let weekStart: typeof import('@/lib/pulse/period').weekStart;

const NOW = 1_790_000_000;
const HOUR = 3600;
const DAY = 86400;

function reply(results: Array<{ s: number; p: string[]; why?: string }>, stop = 'end_turn') {
  return { content: [{ type: 'text', text: JSON.stringify({ results: results.map(r => ({ why: 'work', ...r })) }) }], stop_reason: stop };
}

/** A fake model that answers per session from its content, whatever order the sessions come in. */
function answerBy(pick: (sessionText: string) => string[]) {
  return async (args: { messages: Array<{ content: string }> }) => {
    const parts = args.messages[0].content.split(/\nSession (\d+) \(/).slice(1);
    const results: Array<{ s: number; p: string[] }> = [];
    for (let i = 0; i < parts.length; i += 2) results.push({ s: Number(parts[i]), p: pick(parts[i + 1]) });
    return reply(results);
  };
}

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;
  ({ setConfigValue } = await import('@/lib/config'));
  judge = await import('@/lib/usecases/session-judge');
  ({ createUseCase, updateUseCase } = await import('@/lib/usecases/queries'));
  ({ weekStart } = await import('@/lib/pulse/period'));
  const mod = await import('@anthropic-ai/sdk');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockCreate = (mod as any).__mockCreate;
});
afterAll(async () => cleanup());

beforeEach(async () => {
  await sql.exec(`DELETE FROM use_case_session_judgements; DELETE FROM use_case_week_matches; DELETE FROM use_case_activation_weeks;
    DELETE FROM use_case_skill_drafts; DELETE FROM use_cases; DELETE FROM cowork_skill_invocations; DELETE FROM cowork_mcp_invocations;
    DELETE FROM cowork_session_stats; DELETE FROM code_session_stats; DELETE FROM cowork_messages; DELETE FROM cowork_sessions; DELETE FROM admin_users; DELETE FROM users;`);
  mockCreate.mockReset();
  await setConfigValue('useCasesEnabled', 'true');
  await setConfigValue('useCasesSuggestUseContent', 'true');
  await setConfigValue('anthropicAiApiKey', 'sk-test');
  await setConfigValue('useCaseJudgeModel', '');
});

async function user(id: string, dept: string | null) {
  await sql.run(`INSERT INTO users (id, email, department) VALUES (?, ?, ?)`, [id, `${id}@t.local`, dept]);
}
async function coworkSession(id: string, userId: string, firstAt: number, lastAt: number, prompts: string[]) {
  await sql.run(`INSERT INTO cowork_sessions (id, conversation_id, user_id) VALUES (?, ?, ?)`, [id, id, userId]);
  await sql.run(`INSERT INTO cowork_session_stats (session_id, user_id, first_event_at, last_event_at, computed_at) VALUES (?, ?, ?, ?, ?)`, [id, userId, firstAt, lastAt, NOW]);
  for (const [i, p] of prompts.entries()) {
    await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, content_full, occurred_at)
      VALUES (?, ?, ?, 'cowork_user_message', 'cowork', ?, ?)`, [`${id}-m${i}`, id, userId, p, firstAt + i]);
  }
}
async function codeSession(id: string, userId: string, firstAt: number, lastAt: number, prompts: string[]) {
  await sql.run(`INSERT INTO code_session_stats (session_id, user_id, first_at, last_at, computed_at) VALUES (?, ?, ?, ?, ?)`, [id, userId, firstAt, lastAt, NOW]);
  for (const [i, p] of prompts.entries()) {
    await sql.run(`INSERT INTO cowork_messages (id, session_id, user_id, message_type, surface, content_full, occurred_at)
      VALUES (?, ?, ?, 'code_user_message', 'code', ?, ?)`, [`${id}-m${i}`, id, userId, p, firstAt + i]);
  }
}
async function financeUseCase(extra: Record<string, unknown> = {}) {
  return createUseCase({ title: 'Month-end variance commentary', description: 'Finance drafts the board variance commentary each month end.',
    departments: ['Finance'], keywords: ['variance commentary'], status: 'confirmed', ...extra } as never);
}
async function weekRow(ucId: string, wk: number) {
  return sql.get<{ session_count: number; distinct_users: number; matched_messages: number }>(
    `SELECT session_count, distinct_users, matched_messages FROM use_case_activation_weeks WHERE use_case_id = ? AND week_start = ?`, [ucId, wk]);
}
async function matchedSessions(ucId: string) {
  return (await sql.all<{ session_id: string }>(`SELECT session_id FROM use_case_week_matches WHERE use_case_id = ? ORDER BY session_id`, [ucId])).map(r => r.session_id);
}

describe('pure parts', () => {
  it('spreads prompts across the session: first two, middle two, last two', () => {
    expect(judge.spreadPrompts([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual([1, 2, 5, 6, 9, 10]);
    expect(judge.spreadPrompts([1, 2, 3])).toEqual([1, 2, 3]);
  });
  it('the candidate key changes when a use case is reworded, not when the order changes', () => {
    const a = { id: 'a', title: 'A', description: 'x', keywords: ['k'] };
    const b = { id: 'b', title: 'B', description: null, keywords: [] };
    expect(judge.candidateKey([a, b])).toBe(judge.candidateKey([b, a]));
    expect(judge.candidateKey([a, b])).not.toBe(judge.candidateKey([{ ...a, description: 'y' }, b]));
  });
  it('reads the reply by short id, ignores ids it was not given, and leaves out-of-range sessions null', () => {
    const cands = [{ id: 'uc-1', title: 'A', description: null, keywords: [] }, { id: 'uc-2', title: 'B', description: null, keywords: [] }];
    const out = judge.parseJudgeReply(JSON.stringify({ results: [{ s: 1, p: ['U2', 'U9'], why: 'b' }, { s: 7, p: ['U1'], why: 'x' }] }), cands, 2);
    expect(out).toEqual([{ ids: ['uc-2'], why: 'b' }, null]);
    expect(judge.parseJudgeReply('not json', cands, 2)).toBeNull();
  });
  it('the message shows the person\'s words, not Cowork\'s system text', () => {
    const msg = judge.buildJudgeMessage('Finance', [{ id: 'x', title: 'T', description: 'D', keywords: [] }], [{ surface: 'cowork', prompts: ['draft the commentary'], tools: ['salesforce'] }]);
    expect(msg).toContain('U1: T :: D');
    expect(msg).toContain('draft the commentary');
    expect(msg).toContain('tools: salesforce');
  });
});

describe('runUseCaseJudgeJob', () => {
  it('records the judged sessions as weekly matches; tools alone do not count', async () => {
    await user('anna', 'Finance');
    const uc = await financeUseCase();
    await coworkSession('s-yes', 'anna', NOW - 3 * DAY, NOW - 3 * DAY + HOUR, ['<system-reminder>device</system-reminder> draft the variance commentary', 'tighten the wording']);
    await coworkSession('s-no', 'anna', NOW - 2 * DAY, NOW - 2 * DAY + HOUR, ['book a room for tuesday']);
    mockCreate.mockImplementationOnce(answerBy(t => (t.includes('variance') ? ['U1'] : [])));
    await setConfigValue('useCasesTrackerLastRun', '2099-01-01T00:00:00.000Z');

    const r = await judge.runUseCaseJudgeJob({ nowS: NOW });
    expect(r).toMatchObject({ considered: 2, judged: 2, matchedSessions: 1, failedBatches: 0 });
    // New matches ask the next cycle to refresh the adoption stage.
    const { getConfigValue } = await import('@/lib/config');
    expect(await getConfigValue('useCasesTrackerLastRun')).toBeFalsy();
    expect(await matchedSessions(uc.id)).toEqual(['s-yes']);
    const wk = await weekRow(uc.id, weekStart(NOW - 3 * DAY));
    expect(wk).toMatchObject({ session_count: 1, distinct_users: 1, matched_messages: 2 });

    const args = mockCreate.mock.calls[0][0];
    expect(args.thinking).toEqual({ type: 'disabled' });
    expect(args.output_config.format.type).toBe('json_schema');
    expect(args.model).toBe('claude-sonnet-5');
    expect(args.messages[0].content).not.toContain('system-reminder');
  });

  it('does not judge a session again unless it has new activity or its use cases changed', async () => {
    await user('anna', 'Finance');
    const uc = await financeUseCase();
    await coworkSession('s1', 'anna', NOW - 3 * DAY, NOW - 3 * DAY + HOUR, ['draft the variance commentary']);
    mockCreate.mockResolvedValueOnce(reply([{ s: 1, p: ['U1'] }]));
    await judge.runUseCaseJudgeJob({ nowS: NOW });
    expect((await judge.runUseCaseJudgeJob({ nowS: NOW })).considered).toBe(0);

    // New activity, and this time it is not the work: the match goes, and the week is recounted.
    await sql.run(`UPDATE cowork_session_stats SET last_event_at = ? WHERE session_id = 's1'`, [NOW - 2 * DAY]);
    mockCreate.mockResolvedValueOnce(reply([{ s: 1, p: [] }]));
    await judge.runUseCaseJudgeJob({ nowS: NOW });
    expect(await matchedSessions(uc.id)).toEqual([]);
    expect(await weekRow(uc.id, weekStart(NOW - 3 * DAY))).toMatchObject({ session_count: 0, distinct_users: 0 });

    // Rewording the use case changes the key, so the session is judged again.
    await updateUseCase(uc.id, { description: 'Finance writes the month-end variance commentary for the board pack.' });
    mockCreate.mockResolvedValueOnce(reply([{ s: 1, p: ['U1'] }]));
    expect((await judge.runUseCaseJudgeJob({ nowS: NOW })).considered).toBe(1);
    expect(await matchedSessions(uc.id)).toEqual(['s1']);
  });

  it('a session running the use case\'s own skill matches without asking, even with content off', async () => {
    await user('anna', 'Finance');
    const uc = await financeUseCase();
    await sql.run(`INSERT INTO use_case_skill_drafts (use_case_id, skill_name, description, body_md, owner_questions_json, citations_json, corpus_stats_json, model, generated_at, downloaded_at)
      VALUES (?, 'variance-commentary', 'd', 'b', '[]', '{}', '{}', 'm', ?, ?)`, [uc.id, NOW, NOW]);
    await coworkSession('s-skill', 'anna', NOW - DAY, NOW - DAY + HOUR, ['/variance-commentary']);
    await sql.run(`INSERT INTO cowork_skill_invocations (id, user_id, session_id, skill_name, occurred_at) VALUES ('i1', 'anna', 's-skill', 'acme-library:variance-commentary', ?)`, [NOW - DAY]);
    await setConfigValue('useCasesSuggestUseContent', 'false');

    await judge.runUseCaseJudgeJob({ nowS: NOW });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(await matchedSessions(uc.id)).toEqual(['s-skill']);
    const row = await sql.get<{ skill_matched_ids: string; model: string | null }>(`SELECT skill_matched_ids, model FROM use_case_session_judgements WHERE session_id = 's-skill'`);
    expect(JSON.parse(row!.skill_matched_ids)).toEqual([uc.id]);
    expect(row!.model).toBeNull();
  });

  it('sessions skipped while content was off are judged once it is on', async () => {
    await user('anna', 'Finance');
    const uc = await financeUseCase();
    await coworkSession('s1', 'anna', NOW - DAY, NOW - DAY + HOUR, ['draft the variance commentary']);
    await setConfigValue('useCasesSuggestUseContent', 'false');
    await judge.runUseCaseJudgeJob({ nowS: NOW });
    expect(mockCreate).not.toHaveBeenCalled();

    await setConfigValue('useCasesSuggestUseContent', 'true');
    mockCreate.mockResolvedValueOnce(reply([{ s: 1, p: ['U1'] }]));
    expect((await judge.runUseCaseJudgeJob({ nowS: NOW })).judged).toBe(1);
    expect(await matchedSessions(uc.id)).toEqual(['s1']);
  });

  it('judges Code sessions too, and only finished ones', async () => {
    await user('dev', 'Finance');
    const uc = await financeUseCase();
    await codeSession('c-done', 'dev', NOW - DAY, NOW - DAY + HOUR, ['write the variance commentary generator']);
    await codeSession('c-live', 'dev', NOW - 10 * 60, NOW - 5 * 60, ['still working']);
    mockCreate.mockResolvedValueOnce(reply([{ s: 1, p: ['U1'] }]));
    const r = await judge.runUseCaseJudgeJob({ nowS: NOW });
    expect(r.considered).toBe(1);
    expect(await matchedSessions(uc.id)).toEqual(['c-done']);
    expect(mockCreate.mock.calls[0][0].messages[0].content).toContain('(code, 1 prompts)');
  });

  it('judges a session only against its department\'s use cases and those with no department', async () => {
    await user('anna', 'Finance');
    await user('sam', 'Sales');
    const fin = await financeUseCase();
    const all = await createUseCase({ title: 'Meeting notes', description: 'Anyone writes up meeting notes.', departments: [], status: 'confirmed' } as never);
    await coworkSession('s-sales', 'sam', NOW - DAY, NOW - DAY + HOUR, ['write up the client meeting notes']);
    mockCreate.mockResolvedValueOnce(reply([{ s: 1, p: ['U1'] }]));
    await judge.runUseCaseJudgeJob({ nowS: NOW });
    const msg = mockCreate.mock.calls[0][0].messages[0].content as string;
    expect(msg).toContain('Meeting notes');
    expect(msg).not.toContain('Month-end variance commentary');
    expect(await matchedSessions(all.id)).toEqual(['s-sales']);
    expect(await matchedSessions(fin.id)).toEqual([]);
  });

  it('an API error stops the run and records nothing for the sessions not reached; a cut-off batch is retried', async () => {
    await user('anna', 'Finance');
    await financeUseCase();
    await coworkSession('s1', 'anna', NOW - DAY, NOW - DAY + HOUR, ['draft the variance commentary']);
    mockCreate.mockRejectedValueOnce(new Error('overloaded'));
    const r1 = await judge.runUseCaseJudgeJob({ nowS: NOW });
    expect(r1.apiError).toBe('overloaded');
    expect(await sql.get(`SELECT count(*)::int AS n FROM use_case_session_judgements`)).toEqual({ n: 0 });

    mockCreate.mockResolvedValueOnce(reply([], 'max_tokens'));
    const r2 = await judge.runUseCaseJudgeJob({ nowS: NOW });
    expect(r2.failedBatches).toBe(1);
    expect(await sql.get(`SELECT count(*)::int AS n FROM use_case_session_judgements`)).toEqual({ n: 0 });
  });

  it('an archived use case is not judged against, and its earlier matches are undone', async () => {
    await user('anna', 'Finance');
    const uc = await financeUseCase();
    await coworkSession('s1', 'anna', NOW - DAY, NOW - DAY + HOUR, ['draft the variance commentary']);
    mockCreate.mockResolvedValueOnce(reply([{ s: 1, p: ['U1'] }]));
    await judge.runUseCaseJudgeJob({ nowS: NOW });
    await updateUseCase(uc.id, { status: 'archived' });
    await judge.runUseCaseJudgeJob({ nowS: NOW });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(await matchedSessions(uc.id)).toEqual([]);
  });
});
