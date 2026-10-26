// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/anthropic/model', () => ({ getCoreAiModel: vi.fn(async () => 'claude-haiku-4-5-20251001') }));
vi.mock('@/lib/ingestion/scheduler', () => ({ queueAiCall: vi.fn(async (fn: () => Promise<unknown>) => fn()) }));
const create = vi.fn();
vi.mock('@/lib/anthropic/client', () => ({ createAnthropicClient: vi.fn(() => ({ messages: { create } })), LONG_AI_CALL_TIMEOUT_MS: 300000 }));
vi.mock('@/lib/config', () => ({ getConfigValue: vi.fn(async () => 'sk-test') }));

import { assembleBody, buildSkillDraftPrompt, canvasFactsFrom, generateSkillDraft, SKILL_DRAFT_SCHEMA } from '@/lib/usecases/skill-draft';
import { SKILL_SECTIONS } from '@/lib/usecases/skill-draft-validate';
import type { SkillCorpus } from '@/lib/usecases/skill-corpus';

const corpus: SkillCorpus = {
  excerpts: [
    { index: 0, text: 'draft the month-end variance commentary, flag anything over 5% or 50k', personLabel: 'A', userId: 'u-a', sessionId: 's1', occurredAt: 1_789_000_000, isFollowUp: false },
    { index: 1, text: 'no - one paragraph per line, board tone', personLabel: 'A', userId: 'u-a', sessionId: 's1', occurredAt: 1_789_000_060, isFollowUp: true },
    { index: 2, text: 'tie revenue to salesforce closed-won first', personLabel: 'B', userId: 'u-b', sessionId: 's2', occurredAt: 1_789_100_000, isFollowUp: false },
  ],
  stats: { prompts: 3, distinctPrompts: 3, people: 2, sessions: 2, days: 2, followUps: 1, weeksSpanned: 1, unreadableSessions: 0, firstAt: 1_789_000_000, lastAt: 1_789_100_000 },
  systems: ['salesforce'],
};
const uc = { title: 'Month-end variance commentary', description: null, departments: ['Finance'] };

describe('buildSkillDraftPrompt', () => {
  it('numbers excerpts oldest-first with person labels and dates, never ids, and includes canvas facts when given', () => {
    const canvas = canvasFactsFrom({ story: 'Hand-assembled each close.', valueHypothesis: 'v', people: 3, sessions: 9, occasions: 3, windowDays: 28, rhythm: { label: 'monthly', display: 'Monthly, month-end spike' }, systems: ['salesforce'], activeHours: 4.5, tierNote: 'Mostly tier 2' });
    const { system, user } = buildSkillDraftPrompt(uc, canvas, corpus);
    expect(user).toContain('[0] (2026-09-10, person A)');
    expect(user).toContain('[1] (2026-09-10, person A, follow-up)');
    expect(user).toContain('[2] (2026-09-11, person B)');
    expect(user).not.toContain('u-a');
    expect(user).toContain('Hand-assembled each close.');
    expect(user).toContain('Monthly, month-end spike');
    expect(user).not.toContain('people: 3');           // measured counts never go to the model
    for (const h of SKILL_SECTIONS) expect(system).toContain(`"${h.replace(/^## /, '')}"`);
    expect(system).toMatch(/currency|unit/i);
    expect(system).toMatch(/citation markers|excerpt numbers/i);
  });
  it('lists the digit sequences the excerpts contain and carries the hardened numbers rule', () => {
    const { system, user } = buildSkillDraftPrompt(uc, null, corpus);
    expect(user).toContain('Digits the prompts contain (the only digits you may use): 5, 50');
    expect(system).toMatch(/write every count in words/i);
    expect(system).toMatch(/50k.*never.*50,000/);
    expect(system).toMatch(/example figures/i);
  });
  it('omits the canvas block when there is none', () => {
    expect(buildSkillDraftPrompt(uc, null, corpus).user).not.toContain('How it appears to run today');
  });
});

describe('generateSkillDraft', () => {
  const goodJson = JSON.stringify({
    name: 'month-end-variance-commentary',
    description: 'Drafts board-pack variance commentary. Use when asked for month-end variance commentary.',
    body: SKILL_SECTIONS.map(h => `${h}\nOne paragraph per line. Tie revenue to Salesforce first. Flag over 5% or 50k.`).join('\n\n'),
    ownerQuestions: ['Is the threshold either/or?'],
    citations: { 'Purpose': [0], 'When to use this skill': [0], 'What to ask for before starting': [0], 'Steps': [0, 1, 2], 'Output format': [1], 'Quality rules': [1], 'Edge cases': [2], 'Not part of this skill': [0] },
    excludedExcerpts: [],
  });

  it('calls the injected model with the Core AI model id and returns a validated draft', async () => {
    const calls: Array<{ model: string }> = [];
    const r = await generateSkillDraft(uc, null, corpus, ['salesforce', 'jira'], async args => { calls.push({ model: args.model }); return goodJson; });
    expect(calls).toEqual([{ model: 'claude-haiku-4-5-20251001' }]);
    expect(r.model).toBe('claude-haiku-4-5-20251001');
    expect(r.result.ok).toBe(true);
  });
  it('returns the validation reasons when the model output fails a check, and never throws', async () => {
    const r = await generateSkillDraft(uc, null, corpus, [], async () => goodJson.replace('50k', '$50k'));
    expect(r.result.ok).toBe(false);
    const r2 = await generateSkillDraft(uc, null, corpus, [], async () => { throw new Error('boom'); });
    expect(r2.result).toEqual({ ok: false, reasons: ['model call failed: boom'] });
    const r3 = await generateSkillDraft(uc, null, corpus, [], async () => 'not json');
    expect(r3.result).toEqual({ ok: false, reasons: ['model returned no parseable JSON'] });
  });
  it('makes exactly one call and reports attempts 1 when the first draft is valid', async () => {
    let n = 0;
    const r = await generateSkillDraft(uc, null, corpus, [], async () => { n++; return goodJson; });
    expect(n).toBe(1);
    expect(r.attempts).toBe(1);
    expect(r.result.ok).toBe(true);
  });
  it('repairs once when the first draft fails validation, feeding back the reasons and the previous JSON', async () => {
    const bad = goodJson.replace('50k', '$50k');
    const users: string[] = [];
    const systems: string[] = [];
    const r = await generateSkillDraft(uc, null, corpus, [], async args => { users.push(args.user); systems.push(args.system); return users.length === 1 ? bad : goodJson; });
    expect(users).toHaveLength(2);
    expect(r.attempts).toBe(2);
    expect(r.result.ok).toBe(true);
    expect(systems[1]).toBe(systems[0]);
    expect(users[1].startsWith(users[0])).toBe(true);
    expect(users[1]).toContain('rejected for these reasons');
    expect(users[1]).toContain('$50k');
    expect(users[1]).toContain('Fix exactly these problems and change nothing else.');
    expect(users[1]).toContain(bad);
  });
  it('tries up to two repairs, returns the LAST attempt reasons when all three fail, and never makes a fourth call', async () => {
    let n = 0;
    const r = await generateSkillDraft(uc, null, corpus, [], async () => { n++; return n === 1 ? goodJson.replace('50k', '$50k') : n === 2 ? goodJson.replace('50k', '60k') : goodJson.replace('50k', '70k'); });
    expect(n).toBe(3);
    expect(r.attempts).toBe(3);
    expect(r.result.ok).toBe(false);
    const reasons = r.result.ok ? [] : r.result.reasons;
    expect(reasons.some(x => x.includes('70k'))).toBe(true);
    expect(reasons.some(x => x.includes('$50k') || x.includes('60k'))).toBe(false);
  });
  it('succeeds on the second repair', async () => {
    let n = 0;
    const r = await generateSkillDraft(uc, null, corpus, [], async () => { n++; return n < 3 ? goodJson.replace('50k', '$50k') : goodJson; });
    expect(r.attempts).toBe(3);
    expect(r.result.ok).toBe(true);
  });
  it('hands a draft that fails only minor checks to the owner with a note, instead of failing', async () => {
    const uncited = goodJson.replace('"Steps":[0,1,2]', '"Steps":[]');
    const r = await generateSkillDraft(uc, null, corpus, [], async () => uncited);
    expect(r.attempts).toBe(3);
    expect(r.result.ok).toBe(true);
    if (!r.result.ok) return;
    expect(r.result.draft.ownerQuestions[0]).toMatch(/"Steps" section is not linked to the prompts/);
    expect(r.result.draft.ownerQuestions).toContain('Is the threshold either/or?');
  });
  it('never hands over a draft with an invented number, however many times it fails', async () => {
    const r = await generateSkillDraft(uc, null, corpus, [], async () => goodJson.replace('50k', '70k').replace('"Steps":[0,1,2]', '"Steps":[]'));
    expect(r.result.ok).toBe(false);
  });
});

describe('the real model call (default CallModel)', () => {
  it('forces the reply into the skill schema with thinking off, so the model cannot answer in prose or spend the 8,000 tokens thinking', async () => {
    create.mockReset();
    create.mockResolvedValue({ content: [{ type: 'text', text: '' }], stop_reason: 'end_turn' });
    await generateSkillDraft(uc, null, corpus, [], undefined, 'claude-sonnet-5');
    expect(create).toHaveBeenCalled();
    const args = create.mock.calls[0][0];
    expect(args.model).toBe('claude-sonnet-5');
    expect(args.output_config).toEqual({ format: { type: 'json_schema', schema: SKILL_DRAFT_SCHEMA } });
    expect(args.thinking).toEqual({ type: 'disabled' });
  });
  it('the schema requires every field, one text per section and one citations entry per section', () => {
    const names = SKILL_SECTIONS.map(h => h.replace(/^## /, ''));
    expect(SKILL_DRAFT_SCHEMA.required).toEqual(['name', 'description', 'sections', 'ownerQuestions', 'citations', 'excludedExcerpts']);
    expect(SKILL_DRAFT_SCHEMA.properties.sections.required).toEqual(names);
    expect(SKILL_DRAFT_SCHEMA.properties.citations.required).toEqual(names);
  });
});

describe('sections reply', () => {
  const names = SKILL_SECTIONS.map(h => h.replace(/^## /, ''));
  const sectionsReply = (over: Record<string, string> = {}) => JSON.stringify({
    name: 'month-end-variance-commentary',
    description: 'Drafts board-pack variance commentary. Use when asked for month-end variance commentary.',
    sections: Object.fromEntries(names.map(n => [n, over[n] ?? 'One paragraph per line. Tie revenue to Salesforce first. Flag over 5% or 50k.'])),
    ownerQuestions: ['Is the threshold either/or?'],
    citations: { 'Purpose': [0], 'When to use this skill': [0], 'What to ask for before starting': [0], 'Steps': [0, 1, 2], 'Output format': [1], 'Quality rules': [1], 'Edge cases': [2], 'Not part of this skill': [0] },
    excludedExcerpts: [],
  });

  it('assembles the eight headings in fixed order and validates', async () => {
    const body = JSON.parse(assembleBody(sectionsReply())).body as string;
    expect([...body.matchAll(/^## .+$/gm)].map(m => m[0])).toEqual([...SKILL_SECTIONS]);
    const r = await generateSkillDraft(uc, null, corpus, [], async () => sectionsReply());
    expect(r.result.ok).toBe(true);
  });
  it('drops a repeated heading and demotes a stray "##" inside a section, so the structure cannot break', async () => {
    const reply = sectionsReply({ 'Steps': '## Steps\n1. Pull the figures.\n## Detail\n2. Draft the commentary.' });
    const body = JSON.parse(assembleBody(reply)).body as string;
    expect(body.match(/^## Steps$/gm)).toHaveLength(1);
    expect(body).toContain('### Detail');
    const r = await generateSkillDraft(uc, null, corpus, [], async () => reply);
    expect(r.result.ok).toBe(true);
  });
  it('leaves a reply without sections unchanged', () => {
    expect(assembleBody('not json')).toBe('not json');
    expect(assembleBody('{"body":"x"}')).toBe('{"body":"x"}');
  });
  it('names the copied passage in the repair message, never in the stored reasons', async () => {
    const copied = 'please draft the month end variance commentary for the board pack and flag every material movement';
    const corpusWithLong = { ...corpus, excerpts: [...corpus.excerpts, { index: 3, text: copied, personLabel: 'C', userId: 'u-c', sessionId: 's3', occurredAt: 1_789_200_000, isFollowUp: false }] };
    const users: string[] = [];
    const r = await generateSkillDraft(uc, null, corpusWithLong, [], async args => {
      users.push(args.user);
      return users.length === 1 ? sectionsReply({ 'Purpose': copied }) : sectionsReply();
    });
    expect(r.attempts).toBe(2);
    expect(r.result.ok).toBe(true);
    expect(users[1]).toContain('Reword these passages');
    expect(users[1]).toContain('please draft the month end variance commentary for the board pack');
  });
});
