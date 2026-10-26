// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// DB-read + mocked-LLM tests for runProcessMiningJob / synthesiseDeptProcesses
// (Department Process Transformation). Mirrors
// test/use-cases-emergent-job.test.ts's Anthropic-SDK mock + real-migrations
// harness — the job's internal call to synthesiseDeptProcesses is a same-module ESM
// binding, so only the SDK client itself can be intercepted.
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

async function getMockCreate() {
  const mod = await import('@anthropic-ai/sdk');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (mod as any).__mockCreate as ReturnType<typeof vi.fn>;
}

function makeTextResponse(text: string) {
  return { content: [{ type: 'text', text }] };
}

let sql: TestSql;
let cleanup: () => Promise<void>;

let setConfigValue: typeof import('@/lib/config').setConfigValue;
let getConfigValue: typeof import('@/lib/config').getConfigValue;
let runProcessMiningJob: typeof import('@/lib/usecases/process-mining').runProcessMiningJob;
let synthesiseDeptProcesses: typeof import('@/lib/usecases/process-mining').synthesiseDeptProcesses;
let mockCreate: ReturnType<typeof vi.fn>;
let getSuggestionBySignalKey: typeof import('@/lib/usecases/suggestion-store').getSuggestionBySignalKey;
let upsertOpenSuggestion: typeof import('@/lib/usecases/suggestion-store').upsertOpenSuggestion;
let setSuggestionStatus: typeof import('@/lib/usecases/suggestion-store').setSuggestionStatus;
let countOpenByDepartment: typeof import('@/lib/usecases/suggestion-store').countOpenByDepartment;
let computeProcessKey: typeof import('@/lib/usecases/process-validate').computeProcessKey;

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

beforeAll(async () => {
  const t = await createTestDatabase();
  sql = t.sql;
  cleanup = t.cleanup;

  ({ setConfigValue, getConfigValue } = await import('@/lib/config'));
  ({ runProcessMiningJob, synthesiseDeptProcesses } = await import('@/lib/usecases/process-mining'));
  ({ getSuggestionBySignalKey, upsertOpenSuggestion, setSuggestionStatus, countOpenByDepartment } =
    await import('@/lib/usecases/suggestion-store'));
  ({ computeProcessKey } = await import('@/lib/usecases/process-validate'));
  mockCreate = await getMockCreate();
});

afterAll(async () => cleanup());

async function seedUser(id: string, dept: string | null) {
  await sql.run(`INSERT INTO users (id, email, display_name, department) VALUES (?, ?, ?, ?)`, [id, `${id}@t.local`, id.toUpperCase(), dept]);
}

async function seedMessage(
  msgId: string, userId: string, sessionId: string, occurredAt: number, contentFull: string,
) {
  await sql.run(`INSERT INTO cowork_messages
    (id, session_id, user_id, message_type, surface, content_full, occurred_at)
    VALUES (?, ?, ?, 'cowork_user_message', 'cowork', ?, ?)`, [msgId, sessionId, userId, contentFull, occurredAt]);
}

async function seedSkillInvocation(id: string, sessionId: string, userId: string, skillName: string, occurredAt: number) {
  await sql.run(`INSERT INTO cowork_skill_invocations (id, user_id, session_id, skill_name, occurred_at)
    VALUES (?, ?, ?, ?, ?)`, [id, userId, sessionId, skillName, occurredAt]);
}

async function seedMcpInvocation(id: string, sessionId: string, userId: string, mcpServer: string, occurredAt: number) {
  await sql.run(`INSERT INTO cowork_mcp_invocations (id, user_id, session_id, mcp_server, mcp_tool, occurred_at)
    VALUES (?, ?, ?, ?, 'tool', ?)`, [id, userId, sessionId, mcpServer, occurredAt]);
}

/** Seeds a Finance-department corpus that clears the default bar (2+ users,
 *  2+ distinct UTC days) using whole-day-multiple offsets from NOW so the day
 *  bucketing never straddles a UTC midnight boundary. */
async function seedQualifyingCorpus() {
  await seedUser('anna', 'Finance');
  await seedUser('ben', 'Finance');
  await seedMessage('m-anna-1', 'anna', 's-anna-1', NOW - 10 * DAY, 'Please prepare the variance template for month end');
  await seedMessage('m-anna-2', 'anna', 's-anna-2', NOW - 8 * DAY, 'Following up on the variance template again');
  await seedMessage('m-ben-1', 'ben', 's-ben-1', NOW - 10 * DAY, 'variance template review needed please');
  await seedMessage('m-ben-2', 'ben', 's-ben-2', NOW - 8 * DAY, 'another variance template check today');
}

beforeEach(async () => {
  await sql.exec(`DELETE FROM pulse_classifications; DELETE FROM cowork_mcp_invocations;
           DELETE FROM cowork_skill_invocations; DELETE FROM cowork_session_stats;
           DELETE FROM cowork_sessions; DELETE FROM cowork_messages;
           DELETE FROM admin_users; DELETE FROM users; DELETE FROM use_case_suggestions;`);
  mockCreate.mockReset();
  await setConfigValue('useCasesEnabled', 'true');
  await setConfigValue('useCasesSuggestUseContent', 'true');
  await setConfigValue('processMiningLastRun', '');
  await setConfigValue('processMiningIntervalDays', '7');
  await setConfigValue('processMiningWindowDays', '28');
  await setConfigValue('processMiningMinUsers', '2');
  await setConfigValue('processMiningMaxOpenPerDept', '5');
  await setConfigValue('processMiningModel', '');
  await setConfigValue('processMiningDenylist', '');
  await setConfigValue('useCasesSuggestExcludedSignals', '');
  await setConfigValue('anthropicAiApiKey', '');
});

describe('runProcessMiningJob', () => {
  it('(a) full run writes a dept suggestion whose evidence/canvas numbers come from the corpus, not the mock reply', async () => {
    await seedQualifyingCorpus();
    await setConfigValue('anthropicAiApiKey', 'sk-test-key');
    mockCreate.mockResolvedValueOnce(
      makeTextResponse(
        JSON.stringify([
          {
            title: 'Variance Reporting',
            story: 'This work runs on a fixed rhythm today and could be handed off end to end.',
            valueHypothesis: 'Would free up time for higher value analysis work.',
            keywords: ['variance template'],
            excerptIndices: [0, 1, 2, 3],
          },
        ])
      )
    );

    const result = await runProcessMiningJob({ nowS: NOW });
    expect(result).toEqual({ generated: 1, departments: 1 });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(await getConfigValue('processMiningLastRun')).toBe(String(NOW));

    const signalKey = computeProcessKey('Finance', 'Variance Reporting');
    const row = await getSuggestionBySignalKey(signalKey);
    expect(row).toBeDefined();
    expect(row!.department).toBe('Finance');
    expect(row!.description).toBe('This work runs on a fixed rhythm today and could be handed off end to end.');
    expect(row!.evidence.distinctUsers).toBe(2); // from the CORPUS (anna, ben) — mock never said a number
    expect(row!.evidence.sessionCount).toBe(4);
    expect(row!.evidence.departments).toEqual(['Finance']);
    expect(row!.matchingRule.departments).toEqual(['Finance']);
    expect(row!.matchingRule.keywords).toEqual(['variance template']);

    expect(row!.canvas).not.toBeNull();
    expect(row!.canvas!.people).toBe(2);
    expect(row!.canvas!.sessions).toBe(4);
    expect(row!.canvas!.occasions).toBe(2); // 2 distinct UTC days
    expect(row!.canvas!.windowDays).toBe(28);
    expect(row!.canvas!.story).toBe('This work runs on a fixed rhythm today and could be handed off end to end.');
    expect(row!.canvas!.systems).toEqual([]); // no skills/connectors seeded
    expect(row!.canvas!.activeHours).toBeNull(); // no cowork_session_stats seeded
    expect(row!.canvas!.tierNote).toBeNull(); // no pulse_classifications seeded
  });

  describe('(b) gates', () => {
    it('useCasesEnabled off: no rows, no LLM call', async () => {
      await seedQualifyingCorpus();
      await setConfigValue('useCasesEnabled', 'false');
      await setConfigValue('anthropicAiApiKey', 'sk-test-key');
      const result = await runProcessMiningJob({ nowS: NOW });
      expect(result).toEqual({ generated: 0, departments: 0 });
      expect(mockCreate).not.toHaveBeenCalled();
      expect(await getConfigValue('processMiningLastRun')).toBe('');
    });

    it('useCasesSuggestUseContent off: no rows, no LLM call', async () => {
      await seedQualifyingCorpus();
      await setConfigValue('useCasesSuggestUseContent', 'false');
      await setConfigValue('anthropicAiApiKey', 'sk-test-key');
      const result = await runProcessMiningJob({ nowS: NOW });
      expect(result).toEqual({ generated: 0, departments: 0 });
      expect(mockCreate).not.toHaveBeenCalled();
      expect(await getConfigValue('processMiningLastRun')).toBe('');
    });

    it('cadence not elapsed: skip', async () => {
      await seedQualifyingCorpus();
      await setConfigValue('anthropicAiApiKey', 'sk-test-key');
      const lastRunS = NOW - 1 * DAY;
      await setConfigValue('processMiningIntervalDays', '7');
      await setConfigValue('processMiningLastRun', String(lastRunS));

      const result = await runProcessMiningJob({ nowS: NOW });
      expect(result).toEqual({ generated: 0, departments: 0 });
      expect(mockCreate).not.toHaveBeenCalled();
      expect(await getConfigValue('processMiningLastRun')).toBe(String(lastRunS)); // unchanged
    });

    it('force bypasses cadence', async () => {
      await setConfigValue('anthropicAiApiKey', ''); // no corpus/key needed to prove the gate was passed
      const lastRunS = NOW - 1 * DAY;
      await setConfigValue('processMiningIntervalDays', '7');
      await setConfigValue('processMiningLastRun', String(lastRunS));

      const result = await runProcessMiningJob({ force: true, nowS: NOW });
      expect(result).toEqual({ generated: 0, departments: 0 }); // no corpora seeded
      expect(await getConfigValue('processMiningLastRun')).toBe(String(NOW)); // stamped -> proves it ran, not skipped
    });
  });

  it('(c) per-dept cap: a NEW key is skipped once 5 open dept rows exist, an EXISTING open key still refreshes', async () => {
    await seedQualifyingCorpus();
    await setConfigValue('anthropicAiApiKey', 'sk-test-key');
    await setConfigValue('processMiningMaxOpenPerDept', '5');

    const betaKey = computeProcessKey('Finance', 'Beta Process');
    await upsertOpenSuggestion({
      signalKey: betaKey, title: 'Beta Process', description: 'old desc', department: 'Finance',
      matchingRule: { skills: [], connectors: [], taskTypes: [], departments: ['Finance'] },
      evidence: { distinctUsers: 1, sessionCount: 1, departments: ['Finance'] }, nowS: NOW - 1000,
    });
    for (let i = 0; i < 4; i++) {
      await upsertOpenSuggestion({
        signalKey: `filler-${i}`, title: `Filler ${i}`, description: null, department: 'Finance',
        matchingRule: { skills: [], connectors: [], taskTypes: [], departments: ['Finance'] },
        evidence: { distinctUsers: 1, sessionCount: 1, departments: ['Finance'] }, nowS: NOW - 1000,
      });
    }
    expect(await countOpenByDepartment('Finance')).toBe(5);

    mockCreate.mockResolvedValueOnce(
      makeTextResponse(
        JSON.stringify([
          {
            title: 'Alpha Process', // brand new key — must be skipped, dept is already at the cap
            story: 'This is a new process the department has never registered before today.',
            valueHypothesis: 'Would save meaningful time across the team.',
            keywords: ['variance template'],
            excerptIndices: [0, 1, 2, 3],
          },
          {
            title: 'Beta Process', // existing key — must still refresh, cap does not block a refresh
            story: 'This existing process keeps recurring and could be handed off end to end.',
            valueHypothesis: 'Would free up time for higher value analysis work.',
            keywords: ['variance template'],
            excerptIndices: [0, 1, 2, 3],
          },
        ])
      )
    );

    const result = await runProcessMiningJob({ force: true, nowS: NOW });
    expect(result.generated).toBe(1); // only the refresh counts

    expect(await countOpenByDepartment('Finance')).toBe(5); // no 6th row inserted
    const alphaRow = await getSuggestionBySignalKey(computeProcessKey('Finance', 'Alpha Process'));
    expect(alphaRow).toBeUndefined();

    const betaRow = await getSuggestionBySignalKey(betaKey);
    expect(betaRow).toBeDefined();
    expect(betaRow!.description).toBe('This existing process keeps recurring and could be handed off end to end.');
  });

  it('(d) a dismissed signal_key never reopens', async () => {
    await seedQualifyingCorpus();
    await setConfigValue('anthropicAiApiKey', 'sk-test-key');

    const key = computeProcessKey('Finance', 'Variance Reporting');
    await upsertOpenSuggestion({
      signalKey: key, title: 'Variance Reporting', description: 'old', department: 'Finance',
      matchingRule: { skills: [], connectors: [], taskTypes: [], departments: ['Finance'] },
      evidence: { distinctUsers: 1, sessionCount: 1, departments: ['Finance'] }, nowS: NOW - 1000,
    });
    await setSuggestionStatus((await getSuggestionBySignalKey(key))!.id, 'dismissed');

    mockCreate.mockResolvedValueOnce(
      makeTextResponse(
        JSON.stringify([
          {
            title: 'Variance Reporting',
            story: 'This work runs on a fixed rhythm today and could be handed off end to end.',
            valueHypothesis: 'Would free up time for higher value analysis work.',
            keywords: ['variance template'],
            excerptIndices: [0, 1, 2, 3],
          },
        ])
      )
    );

    const result = await runProcessMiningJob({ force: true, nowS: NOW });
    expect(result.generated).toBe(0);
    const row = await getSuggestionBySignalKey(key);
    expect(row!.status).toBe('dismissed');
    expect(row!.description).toBe('old'); // untouched — never reopened/refreshed
  });

  it('(e) a below-bar department gets zero LLM calls', async () => {
    // Only 1 user, 1 session, 1 occasion — does not clear minUsers(2).
    await seedUser('cara', 'Ops');
    await seedMessage('m-cara-1', 'cara', 's-cara-1', NOW - 2 * DAY, 'a single one-off prompt');
    await setConfigValue('anthropicAiApiKey', 'sk-test-key');

    const result = await runProcessMiningJob({ nowS: NOW });
    expect(result).toEqual({ generated: 0, departments: 0 });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('(f) a digit-bearing story in the mock reply is dropped: nothing stored', async () => {
    await seedQualifyingCorpus();
    await setConfigValue('anthropicAiApiKey', 'sk-test-key');
    mockCreate.mockResolvedValueOnce(
      makeTextResponse(
        JSON.stringify([
          {
            title: 'Variance Reporting',
            story: 'This happens 3 times a month and could be handed off end to end.', // digit -> dropped
            valueHypothesis: 'Would free up time for higher value analysis work.',
            keywords: ['variance template'],
            excerptIndices: [0, 1, 2, 3],
          },
        ])
      )
    );

    const result = await runProcessMiningJob({ nowS: NOW });
    expect(result).toEqual({ generated: 0, departments: 1 }); // the dept still got its one LLM call
    const row = await getSuggestionBySignalKey(computeProcessKey('Finance', 'Variance Reporting'));
    expect(row).toBeUndefined();
  });

  it('(g) commodity trim (I-2): the default trim removes a commodity skill from matchingRule but canvas.systems keeps the full untrimmed list; a non-commodity skill and a connector survive the rule', async () => {
    await seedQualifyingCorpus();
    await seedSkillInvocation('si-1', 's-anna-1', 'anna', 'anthropic-skills:xlsx', NOW - 10 * DAY);
    await seedSkillInvocation('si-2', 's-ben-1', 'ben', 'month-end-pack-builder', NOW - 10 * DAY);
    await seedMcpInvocation('mi-1', 's-anna-2', 'anna', 'salesforce', NOW - 8 * DAY);
    await setConfigValue('anthropicAiApiKey', 'sk-test-key');
    mockCreate.mockResolvedValueOnce(
      makeTextResponse(
        JSON.stringify([
          {
            title: 'Variance Reporting',
            story: 'This work runs on a fixed rhythm today and could be handed off end to end.',
            valueHypothesis: 'Would free up time for higher value analysis work.',
            keywords: ['variance template'],
            excerptIndices: [0, 1, 2, 3],
          },
        ])
      )
    );

    const result = await runProcessMiningJob({ nowS: NOW });
    expect(result).toEqual({ generated: 1, departments: 1 });

    const row = await getSuggestionBySignalKey(computeProcessKey('Finance', 'Variance Reporting'));
    expect(row).toBeDefined();
    expect(row!.matchingRule.skills).toEqual(['month-end-pack-builder']); // xlsx trimmed by DEFAULT_RULE_SIGNAL_TRIM
    expect(row!.matchingRule.connectors).toEqual(['salesforce']); // not commodity, kept
    expect([...row!.canvas!.systems].sort()).toEqual(
      ['anthropic-skills:xlsx', 'month-end-pack-builder', 'salesforce'].sort()
    ); // canvas keeps the FULL observed list, untrimmed
  });

  it('(h) commodity trim (I-2): the admin useCasesSuggestExcludedSignals list also trims a connector from the matching rule, while canvas.systems keeps it', async () => {
    await seedQualifyingCorpus();
    await seedMcpInvocation('mi-2', 's-anna-2', 'anna', 'salesforce', NOW - 8 * DAY);
    await setConfigValue('anthropicAiApiKey', 'sk-test-key');
    await setConfigValue('useCasesSuggestExcludedSignals', JSON.stringify(['salesforce']));
    mockCreate.mockResolvedValueOnce(
      makeTextResponse(
        JSON.stringify([
          {
            title: 'Variance Reporting',
            story: 'This work runs on a fixed rhythm today and could be handed off end to end.',
            valueHypothesis: 'Would free up time for higher value analysis work.',
            keywords: ['variance template'],
            excerptIndices: [0, 1, 2, 3],
          },
        ])
      )
    );

    const result = await runProcessMiningJob({ nowS: NOW });
    expect(result).toEqual({ generated: 1, departments: 1 });

    const row = await getSuggestionBySignalKey(computeProcessKey('Finance', 'Variance Reporting'));
    expect(row).toBeDefined();
    expect(row!.matchingRule.connectors).toEqual([]); // trimmed by the admin-edited list
    expect(row!.canvas!.systems).toEqual(['salesforce']); // observed facts stay honest, untrimmed
  });

  describe('(i) prior-titles dedup block (I-3)', () => {
    it('an existing title (any status) for the department appears inside a "do NOT re-propose" block in the prompt', async () => {
      await setConfigValue('anthropicAiApiKey', 'sk-test-key');
      const priorKey = computeProcessKey('Finance', 'Month-end variance commentary');
      await upsertOpenSuggestion({
        signalKey: priorKey, title: 'Month-end variance commentary', description: 'old', department: 'Finance',
        matchingRule: { skills: [], connectors: [], taskTypes: [], departments: ['Finance'] },
        evidence: { distinctUsers: 1, sessionCount: 1, departments: ['Finance'] }, nowS: NOW - 1000,
      });
      await setSuggestionStatus((await getSuggestionBySignalKey(priorKey))!.id, 'dismissed');

      mockCreate.mockResolvedValueOnce(makeTextResponse(JSON.stringify([])));

      await synthesiseDeptProcesses(
        { department: 'Finance', excerpts: [{ index: 0, text: 'hi there', userId: 'a', sessionId: 's', occurredAt: NOW }] },
        [],
        { minUsers: 2 },
      );

      expect(mockCreate).toHaveBeenCalledTimes(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const userMsg = (mockCreate.mock.calls[0][0] as any).messages[0].content as string;
      expect(userMsg).toContain('Already proposed for this department (do NOT re-propose these processes, even reworded):');
      expect(userMsg).toContain('Month-end variance commentary');
    });

    it('a department with no existing titles gets NO such block', async () => {
      await setConfigValue('anthropicAiApiKey', 'sk-test-key');
      mockCreate.mockResolvedValueOnce(makeTextResponse(JSON.stringify([])));

      await synthesiseDeptProcesses(
        { department: 'Ops', excerpts: [{ index: 0, text: 'hi there', userId: 'a', sessionId: 's', occurredAt: NOW }] },
        [],
        { minUsers: 2 },
      );

      expect(mockCreate).toHaveBeenCalledTimes(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const userMsg = (mockCreate.mock.calls[0][0] as any).messages[0].content as string;
      expect(userMsg).not.toContain('Already proposed');
    });
  });
});

describe('synthesiseDeptProcesses', () => {
  it('no API key: returns [] without calling the model', async () => {
    await setConfigValue('anthropicAiApiKey', '');
    const { DEFAULT_PROCESS_DENYLIST } = await import('@/lib/usecases/process-validate');
    const out = await synthesiseDeptProcesses(
      { department: 'Finance', excerpts: [{ index: 0, text: 'hi', userId: 'a', sessionId: 's', occurredAt: NOW }] },
      DEFAULT_PROCESS_DENYLIST,
      { minUsers: 2 },
    );
    expect(out).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('empty excerpts: returns [] without calling the model', async () => {
    await setConfigValue('anthropicAiApiKey', 'sk-test-key');
    const { DEFAULT_PROCESS_DENYLIST } = await import('@/lib/usecases/process-validate');
    const out = await synthesiseDeptProcesses(
      { department: 'Finance', excerpts: [] },
      DEFAULT_PROCESS_DENYLIST,
      { minUsers: 2 },
    );
    expect(out).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  const twoDayExcerpts = [
    { index: 0, text: 'prepare the variance template', userId: 'a', sessionId: 's1', occurredAt: NOW - 10 * DAY },
    { index: 1, text: 'variance template review', userId: 'b', sessionId: 's2', occurredAt: NOW - 8 * DAY },
  ];

  it('asks for a fixed reply shape with thinking off, and reads { processes: [...] }', async () => {
    await setConfigValue('anthropicAiApiKey', 'sk-test-key');
    const { DEFAULT_PROCESS_DENYLIST } = await import('@/lib/usecases/process-validate');
    mockCreate.mockResolvedValueOnce({ ...makeTextResponse(JSON.stringify({ processes: [{
      title: 'Month-end variance commentary', story: 'Finance drafts the variance commentary each close.',
      valueHypothesis: 'Faster close.', keywords: ['variance template'], excerptIndices: [0, 1],
    }] })), stop_reason: 'end_turn' });
    const out = await synthesiseDeptProcesses({ department: 'Finance', excerpts: twoDayExcerpts }, DEFAULT_PROCESS_DENYLIST, { minUsers: 2 });
    expect(out.map(c => c.title)).toEqual(['Month-end variance commentary']);
    const args = mockCreate.mock.calls[0][0];
    expect(args.thinking).toEqual({ type: 'disabled' });
    expect(args.max_tokens).toBe(4000);
    expect(args.output_config.format.type).toBe('json_schema');
    expect(args.system).toMatch(/never describe a process by how it runs/i);
  });

  it('reports a cut-off or unreadable reply as a failure, not as "nothing found"', async () => {
    await setConfigValue('anthropicAiApiKey', 'sk-test-key');
    const { DEFAULT_PROCESS_DENYLIST } = await import('@/lib/usecases/process-validate');
    const failures: string[] = [];
    mockCreate.mockResolvedValueOnce({ ...makeTextResponse('{"processes": [{"title": "Mon'), stop_reason: 'max_tokens' });
    expect(await synthesiseDeptProcesses({ department: 'Finance', excerpts: twoDayExcerpts }, DEFAULT_PROCESS_DENYLIST, { minUsers: 2 }, r => failures.push(r))).toEqual([]);
    mockCreate.mockResolvedValueOnce({ ...makeTextResponse('not json'), stop_reason: 'end_turn' });
    await synthesiseDeptProcesses({ department: 'Sales', excerpts: twoDayExcerpts }, DEFAULT_PROCESS_DENYLIST, { minUsers: 2 }, r => failures.push(r));
    expect(failures).toEqual(['Finance: reply cut off at 4000 tokens', 'Sales: unreadable reply']);
  });

  it('the job marks itself done, then throws so the failure shows in System health', async () => {
    await seedQualifyingCorpus();
    await setConfigValue('anthropicAiApiKey', 'sk-test-key');
    mockCreate.mockResolvedValueOnce({ ...makeTextResponse('{"processes": ['), stop_reason: 'max_tokens' });
    await expect(runProcessMiningJob({ nowS: NOW })).rejects.toThrow(/Process mining failed for 1 department\(s\): Finance: reply cut off/);
    expect(await getConfigValue('processMiningLastRun')).toBe(String(NOW));
  });
});

describe('buildMiningExcerpts', () => {
  it('shows each session\'s clues once, on its first excerpt', async () => {
    const { buildMiningExcerpts } = await import('@/lib/usecases/process-mining');
    const msg = buildMiningExcerpts({
      department: 'Finance',
      excerpts: [
        { index: 0, text: 'chase the timesheets', userId: 'a', sessionId: 's1', occurredAt: 1 },
        { index: 1, text: 'now draft the emails', userId: 'a', sessionId: 's1', occurredAt: 2 },
        { index: 2, text: 'something else', userId: 'b', sessionId: 's2', occurredAt: 3 },
      ],
      clues: { s1: { made: ['chase-list.md'], uploaded: [], actions: ['gmail create_draft'] } },
    });
    expect(msg.split('\n')).toEqual([
      'Excerpt 0: "chase the timesheets" [its session: files made: chase-list.md; connector actions: gmail create_draft]',
      'Excerpt 1: "now draft the emails"',
      'Excerpt 2: "something else"',
    ]);
  });
});

describe('cross-department suggestions', () => {
  it('suggests work seen in two departments below the department boxes, with both departments on it', async () => {
    await setConfigValue('anthropicAiApiKey', 'sk-test');
    for (const [u, d] of [['anna', 'Finance'], ['ben', 'Finance'], ['cara', 'Sales'], ['dan', 'Sales']] as const) await seedUser(u, d);
    let k = 0;
    for (const u of ['anna', 'ben', 'cara', 'dan']) for (const daysAgo of [20, 14, 8, 2]) {
      k++;
      await seedMessage(`m-x-${k}`, u, `s-x-${k}`, NOW - daysAgo * DAY, `put together my weekly team briefing from the inbox and calendar, week ${daysAgo}`);
    }
    const systems: string[] = [];
    mockCreate.mockImplementation(async (args: { system: string; messages: Array<{ content: string }> }) => {
      systems.push(args.system);
      if (!args.system.includes('at least two different departments')) return makeTextResponse(JSON.stringify({ processes: [] }));
      const cited = [...args.messages[0].content.matchAll(/^Excerpt (\d+) \((Finance|Sales)\)/gm)].map(m => Number(m[1]));
      return makeTextResponse(JSON.stringify({ processes: [{
        title: 'Weekly team briefing', story: 'People compile a weekly team briefing from their inbox and calendar.',
        valueHypothesis: 'Briefings ready without manual assembly.', keywords: ['weekly team briefing'], excerptIndices: cited,
      }] }));
    });

    const r = await runProcessMiningJob({ force: true, nowS: NOW });
    expect(r.generated).toBeGreaterThanOrEqual(1); // the same title from several reads refreshes one row
    expect(systems.filter(x => x.includes('at least two different departments'))).toHaveLength(4); // four cross-department reads first
    expect(systems.filter(x => !x.includes('at least two different departments'))).toHaveLength(2); // then Finance and Sales
    const s = await getSuggestionBySignalKey(computeProcessKey('Across departments', 'Weekly team briefing'));
    expect(s).toMatchObject({ department: null, status: 'open', title: 'Weekly team briefing' });
    expect(s!.canvas?.departments).toEqual(['Finance', 'Sales']);
    expect(s!.matchingRule.departments).toEqual(['Finance', 'Sales']);
    expect(s!.canvas!.people).toBeGreaterThanOrEqual(2);
  });

  it('a department with one person gets no call, but its prompts still count across departments', async () => {
    await setConfigValue('anthropicAiApiKey', 'sk-test');
    await seedUser('solo', 'Legal');
    await seedUser('cara', 'Sales');
    await seedUser('dan', 'Sales');
    let k = 0;
    for (const u of ['solo', 'cara', 'dan']) for (const daysAgo of [12, 5]) {
      k++;
      await seedMessage(`m-y-${k}`, u, `s-y-${k}`, NOW - daysAgo * DAY, 'weekly contract renewal summary');
    }
    const systems: string[] = [];
    mockCreate.mockImplementation(async (args: { system: string; messages: Array<{ content: string }> }) => {
      systems.push(args.system);
      return makeTextResponse(JSON.stringify({ processes: [] }));
    });
    await runProcessMiningJob({ force: true, nowS: NOW });
    expect(systems.filter(x => !x.includes('at least two different departments'))).toHaveLength(1); // Sales only; Legal screened out
    expect(systems[0]).toContain('at least two different departments');
  });
});

describe('cross-department pass and earlier decisions', () => {
  it('is told department titles people dismissed or confirmed, not ones still open', async () => {
    await setConfigValue('anthropicAiApiKey', 'sk-test');
    for (const [u, d] of [['anna', 'Finance'], ['cara', 'Sales']] as const) await seedUser(u, d);
    await seedMessage('m-z-1', 'anna', 's-z-1', NOW - 9 * DAY, 'weekly team note');
    await seedMessage('m-z-2', 'cara', 's-z-2', NOW - 2 * DAY, 'weekly team note');
    const base = { description: 'd', matchingRule: { skills: [], connectors: [], taskTypes: [], departments: ['Finance'] }, evidence: { distinctUsers: 2, sessionCount: 2, departments: ['Finance'] }, nowS: NOW,
      canvas: { story: 's', valueHypothesis: 'v', people: 2, sessions: 2, occasions: 2, windowDays: 28, rhythm: { label: 'weekly' as const, display: 'Weekly' }, systems: [], activeHours: null, tierNote: null } };
    await upsertOpenSuggestion({ ...base, signalKey: 'kz-dismissed', title: 'Dismissed finance process', department: 'Finance' });
    await upsertOpenSuggestion({ ...base, signalKey: 'kz-open', title: 'Open finance process', department: 'Finance' });
    const dismissed = await getSuggestionBySignalKey('kz-dismissed');
    await setSuggestionStatus(dismissed!.id, 'dismissed');
    const users: string[] = [];
    mockCreate.mockImplementation(async (args: { system: string; messages: Array<{ content: string }> }) => {
      if (args.system.includes('at least two different departments')) users.push(args.messages[0].content);
      return makeTextResponse(JSON.stringify({ processes: [] }));
    });
    await runProcessMiningJob({ force: true, nowS: NOW });
    expect(users).toHaveLength(1);
    expect(users[0]).toContain('"Dismissed finance process"');
    expect(users[0]).not.toContain('"Open finance process"');
  });
});

describe('cross-department cap', () => {
  it('keeps at most ACROSS_MAX_OPEN cross-department suggestions open; departments keep their own cap', async () => {
    const { ACROSS_MAX_OPEN, ACROSS_READS } = await import('@/lib/usecases/process-mining');
    expect(ACROSS_MAX_OPEN).toBe(10);
    expect(ACROSS_READS).toBe(4);
    await setConfigValue('anthropicAiApiKey', 'sk-test');
    const canvas = { story: 's', valueHypothesis: 'v', departments: ['Finance', 'Sales'], people: 2, sessions: 2, occasions: 2, windowDays: 28, rhythm: { label: 'weekly' as const, display: 'Weekly' }, systems: [], activeHours: null, tierNote: null };
    for (let i = 0; i < ACROSS_MAX_OPEN; i++) {
      await upsertOpenSuggestion({ signalKey: `cap-${i}`, title: `Existing across ${i}`, description: 'd', canvas,
        matchingRule: { skills: [], connectors: [], taskTypes: [], departments: ['Finance', 'Sales'] }, evidence: { distinctUsers: 2, sessionCount: 2, departments: ['Finance', 'Sales'] }, nowS: NOW });
    }
    for (const [u, d] of [['anna', 'Finance'], ['ben', 'Finance'], ['cara', 'Sales'], ['dan', 'Sales']] as const) await seedUser(u, d);
    let k = 0;
    for (const u of ['anna', 'ben', 'cara', 'dan']) for (const daysAgo of [20, 14, 8, 2]) {
      k++;
      await seedMessage(`m-cap-${k}`, u, `s-cap-${k}`, NOW - daysAgo * DAY, `monday priorities note, week ${daysAgo}`);
    }
    mockCreate.mockImplementation(async (args: { system: string; messages: Array<{ content: string }> }) => {
      if (!args.system.includes('at least two different departments')) return makeTextResponse(JSON.stringify({ processes: [] }));
      const cited = [...args.messages[0].content.matchAll(/^Excerpt (\d+) \(/gm)].map(m => Number(m[1]));
      return makeTextResponse(JSON.stringify({ processes: [{ title: 'Monday priorities note', story: 'People write a Monday priorities note.', valueHypothesis: 'Notes ready sooner.', keywords: ['priorities note'], excerptIndices: cited }] }));
    });
    await runProcessMiningJob({ force: true, nowS: NOW });
    expect(await getSuggestionBySignalKey(computeProcessKey('Across departments', 'Monday priorities note'))).toBeUndefined();
  });
});

describe('department reads, Claude Code prompts and checks', () => {
  async function seedCodeMessage(msgId: string, userId: string, sessionId: string, occurredAt: number, contentFull: string) {
    await sql.run(`INSERT INTO cowork_messages
      (id, session_id, user_id, message_type, surface, content_full, occurred_at)
      VALUES (?, ?, ?, 'code_user_message', 'code', ?, ?)`, [msgId, sessionId, userId, contentFull, occurredAt]);
  }
  /** Replies citing every excerpt shown, with the given title (one process per call). */
  const citeAll = (title: string) => (args: { messages: Array<{ content: string }> }) => {
    const cited = [...args.messages[0].content.matchAll(/^Excerpt (\d+)[ :]/gm)].map(m => Number(m[1]));
    return makeTextResponse(JSON.stringify({ processes: [{ title, story: 'People repeat this job the same way.', valueHypothesis: 'It would be ready sooner.', keywords: ['template'], excerptIndices: cited }] }));
  };

  it('mines Claude Code prompts too, stores where each was found, and a department with both is one box with two lists', async () => {
    await seedQualifyingCorpus();
    await seedCodeMessage('c-anna-1', 'anna', 'cs-anna-1', NOW - 10 * DAY, 'run the pull request template review');
    await seedCodeMessage('c-anna-2', 'anna', 'cs-anna-2', NOW - 8 * DAY, 'pull request template review again');
    await seedCodeMessage('c-ben-1', 'ben', 'cs-ben-1', NOW - 10 * DAY, 'pull request template check please');
    await seedCodeMessage('c-ben-2', 'ben', 'cs-ben-2', NOW - 8 * DAY, 'another pull request template check');
    await setConfigValue('anthropicAiApiKey', 'sk-test-key');
    mockCreate.mockImplementationOnce(citeAll('Variance commentary')).mockImplementationOnce(citeAll('Pull request review'));

    const result = await runProcessMiningJob({ nowS: NOW });
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result.generated).toBe(2);
    const cowork = await getSuggestionBySignalKey(computeProcessKey('Finance', 'Variance commentary'));
    const code = await getSuggestionBySignalKey(computeProcessKey('Finance', 'Pull request review'));
    expect(cowork?.surface).toBe('cowork');
    expect(code?.surface).toBe('code');
    // The Claude Code read is told what the Cowork read already stored.
    expect(mockCreate.mock.calls[1][0].messages[0].content).toContain('"Variance commentary"');

    const { listOpenDeptBoxes } = await import('@/lib/usecases/suggestion-store');
    const boxes = await listOpenDeptBoxes();
    expect(boxes.map(b => [b.label, b.groups.map(g => g.label)])).toEqual([['Finance', ['Cowork', 'Claude Code']]]);
  });

  it('a department with more than 240 usable prompts gets one read per 120, each told what earlier reads stored, with no cap', async () => {
    await seedUser('anna', 'Finance');
    await seedUser('ben', 'Finance');
    // 250 usable prompts -> 3 reads; text differs per prompt so the identical-prompt cap does not bite.
    for (let i = 0; i < 250; i++) {
      await seedMessage(`m-big-${i}`, i % 2 ? 'ben' : 'anna', `s-big-${i}`, NOW - (1 + (i % 20)) * DAY, `month end template ${i}`);
    }
    await setConfigValue('anthropicAiApiKey', 'sk-test-key');
    await setConfigValue('processMiningMaxOpenPerDept', '1'); // a small department would stop at one
    let n = 0;
    mockCreate.mockImplementation((args: { messages: Array<{ content: string }> }) => citeAll(`Template job ${['alpha', 'beta', 'gamma', 'delta'][n++]}`)(args));

    await runProcessMiningJob({ nowS: NOW });
    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(await countOpenByDepartment('Finance')).toBe(3);
    expect(mockCreate.mock.calls[2][0].messages[0].content).toContain('"Template job alpha", "Template job beta"');
  });

  it('a new suggestion built mostly on the sessions of one a person dismissed is not suggested again', async () => {
    await seedQualifyingCorpus();
    await upsertOpenSuggestion({
      signalKey: 'dismissed-1', title: 'Variance pack', description: 'd', department: 'Finance',
      matchingRule: { skills: [], connectors: [], taskTypes: [], departments: ['Finance'] },
      evidence: { distinctUsers: 2, sessionCount: 4, departments: ['Finance'] },
      citedSessions: ['s-anna-1', 's-anna-2', 's-ben-1'], nowS: NOW,
    });
    const dismissed = await getSuggestionBySignalKey('dismissed-1');
    await setSuggestionStatus(dismissed!.id, 'dismissed');
    await setConfigValue('anthropicAiApiKey', 'sk-test-key');
    mockCreate.mockImplementationOnce(citeAll('Month-end variance write-up')); // reworded, 3 of its 4 sessions shared

    await runProcessMiningJob({ nowS: NOW });
    expect(await getSuggestionBySignalKey(computeProcessKey('Finance', 'Month-end variance write-up'))).toBeUndefined();
  });

  it('drops personal study and slide work from department suggestions, in code', async () => {
    await seedQualifyingCorpus();
    await setConfigValue('anthropicAiApiKey', 'sk-test-key');
    mockCreate.mockImplementationOnce((args: { messages: Array<{ content: string }> }) => {
      const cited = [...args.messages[0].content.matchAll(/^Excerpt (\d+)[ :]/gm)].map(m => Number(m[1]));
      const p = (title: string) => ({ title, story: 'People repeat this job the same way.', valueHypothesis: 'It would be ready sooner.', keywords: ['template'], excerptIndices: cited });
      return makeTextResponse(JSON.stringify({ processes: [p('Mock certification exam generation'), p('Slide template rebranding'), p('Variance template review')] }));
    });
    await runProcessMiningJob({ nowS: NOW });
    expect(await getSuggestionBySignalKey(computeProcessKey('Finance', 'Mock certification exam generation'))).toBeUndefined();
    expect(await getSuggestionBySignalKey(computeProcessKey('Finance', 'Slide template rebranding'))).toBeUndefined();
    expect(await getSuggestionBySignalKey(computeProcessKey('Finance', 'Variance template review'))).toBeDefined();
  });
});
