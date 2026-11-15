// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Spend Review with ChatGPT and Codex (pure parts): each hour's ChatGPT cost
// shared across that hour's replies, and model advice that never crosses
// vendors.
import { describe, it, expect } from 'vitest';
import { shareHourlyCosts, type HourlyCost, type Reply } from '@/lib/finance/spend-review-openai';
import { deriveModelFit, modelVendor, newTally, tallySession, MIN_ADVICE_SESSIONS } from '@/lib/finance/spend-review';
import { DEFAULT_RATES, OPENAI_DEFAULT_RATES } from '@/lib/pulse/code/rates';

const H = 1_790_000_000 - (1_790_000_000 % 3600); // an hour boundary
const usage = (inputTokens: number) => ({ inputTokens, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 });
const RATES = { ...DEFAULT_RATES, ...OPENAI_DEFAULT_RATES };
const TERRA = 'gpt-6.1-terra'; // $1 / MTok in

describe('shareHourlyCosts', () => {
  it('shares an hour across its replies on that model, by conversation', () => {
    const costs: HourlyCost[] = [{ userId: 'u', model: TERRA, hourStart: H, usage: usage(3_000_000) }]; // $3
    const replies: Reply[] = [
      { userId: 'u', sessionId: 'chatgpt:a', model: TERRA, occurredAt: H + 60 },
      { userId: 'u', sessionId: 'chatgpt:a', model: TERRA, occurredAt: H + 120 },
      { userId: 'u', sessionId: 'chatgpt:b', model: TERRA, occurredAt: H + 3000 },
      { userId: 'u', sessionId: 'chatgpt:c', model: 'gpt-6', occurredAt: H + 30 }, // another model: not this cost's
      { userId: 'u', sessionId: 'chatgpt:d', model: TERRA, occurredAt: H + 3600 }, // the next hour
    ];
    const r = shareHourlyCosts(costs, replies, RATES);
    expect(r.bySession.get('chatgpt:a')!.parts[0].usd).toBeCloseTo(2, 6);
    expect(r.bySession.get('chatgpt:a')!.parts[0].usage.inputTokens).toBeCloseTo(2_000_000, 0);
    expect(r.bySession.get('chatgpt:b')!.parts[0].usd).toBeCloseTo(1, 6);
    expect(r.bySession.has('chatgpt:c')).toBe(false);
    expect(r.bySession.has('chatgpt:d')).toBe(false);
    expect(r.unmatchedByUser.size).toBe(0);
  });

  it('falls back to any reply in the hour, then keeps the cost with the person', () => {
    const costs: HourlyCost[] = [
      { userId: 'u', model: TERRA, hourStart: H, usage: usage(1_000_000) },          // no TERRA reply: shared over gpt-6 replies
      { userId: 'u', model: TERRA, hourStart: H + 7200, usage: usage(2_000_000) },   // no reply at all: unmatched
      { userId: 'v', model: TERRA, hourStart: H, usage: usage(1_000_000) },          // someone else's hour
    ];
    const replies: Reply[] = [{ userId: 'u', sessionId: 'chatgpt:x', model: 'gpt-6', occurredAt: H + 10 }];
    const r = shareHourlyCosts(costs, replies, RATES);
    expect(r.bySession.get('chatgpt:x')!.parts[0]).toMatchObject({ model: TERRA, replies: 1 });
    expect(r.bySession.get('chatgpt:x')!.parts[0].usd).toBeCloseTo(1, 6);
    expect(r.unmatchedByUser.get('u')).toBeCloseTo(2, 6);
    expect(r.unmatchedByUser.get('v')).toBeCloseTo(1, 6);
  });

  it('names an unpriced model and never counts it', () => {
    const r = shareHourlyCosts(
      [{ userId: 'u', model: 'gpt-unknown', hourStart: H, usage: usage(1_000_000) }],
      [{ userId: 'u', sessionId: 'chatgpt:a', model: 'gpt-unknown', occurredAt: H + 1 }],
      RATES,
    );
    expect(r.unpricedModels).toEqual(new Set(['gpt-unknown']));
    expect(r.bySession.get('chatgpt:a')!.parts[0].usd).toBeNull();
  });

  it("values an hour with only token totals at OpenAI's own figure, never $0", () => {
    const r = shareHourlyCosts(
      [
        { userId: 'u', model: TERRA, hourStart: H, usage: usage(0), reportedUsd: 4 },
        { userId: 'u', model: 'gpt-6', hourStart: H + 3600, usage: usage(0), reportedUsd: null }, // no figure either
      ],
      [
        { userId: 'u', sessionId: 'chatgpt:a', model: TERRA, occurredAt: H + 1 },
        { userId: 'u', sessionId: 'chatgpt:b', model: 'gpt-6', occurredAt: H + 3601 },
      ],
      RATES,
    );
    expect(r.bySession.get('chatgpt:a')!.parts[0].usd).toBeCloseTo(4, 6);
    expect(r.bySession.get('chatgpt:b')!.parts[0].usd).toBeNull();
    expect(r.unpricedModels).toEqual(new Set(['gpt-6']));
  });

  it("prices an hour with a token split from the tokens, ignoring OpenAI's figure", () => {
    const r = shareHourlyCosts(
      [{ userId: 'u', model: TERRA, hourStart: H, usage: usage(1_000_000), reportedUsd: 9.99 }],
      [{ userId: 'u', sessionId: 'chatgpt:a', model: TERRA, occurredAt: H + 1 }],
      RATES,
    );
    expect(r.bySession.get('chatgpt:a')!.parts[0].usd).toBeCloseTo(1, 6);
  });
});

describe('model advice stays with one vendor', () => {
  const tally = (n: number, people: number, spend: number, tier: number) => {
    const t = newTally();
    for (let i = 0; i < n; i++) tallySession(t, { userId: `p${i % people}`, spend, produced: null, tier });
    return t;
  };
  const USAGE = (m: string) => new Map([[m, { inputTokens: 50_000_000, outputTokens: 5_000_000, cacheReadTokens: 0, cacheCreationTokens: 0 }]]);
  // Where the person's sessions on a model ran.
  const ran = (m: string, ...products: Array<'chat' | 'work'>) => new Map([[m, products]]);

  it('tells models apart by vendor', () => {
    expect(modelVendor('claude-haiku-4-5')).toBe('anthropic');
    expect(modelVendor('us.anthropic.claude-opus-4-6-v1')).toBe('anthropic');
    expect(modelVendor('gpt-6-pro')).toBe('openai');
  });

  it('a ChatGPT trial suggests a cheaper OpenAI model, never Claude', () => {
    const you = new Map([['gpt-6-pro', tally(10, 1, 5, 3)]]);
    const { trial } = deriveModelFit('chatgpt', you, new Map(), USAGE('gpt-6-pro'), RATES, 100);
    expect(trial).not.toBeNull();
    expect(modelVendor(trial!.toModel)).toBe('openai');
  });

  it('a Codex trial never suggests a Chat-only or research model', () => {
    const you = new Map([['gpt-6-astra', tally(10, 1, 5, 3)]]);
    const only = (...ms: string[]) => Object.fromEntries(ms.map(m => [m, RATES[m]]));
    // gpt-6 (Chat only) is the only cheaper general model here, so nothing is suggested.
    expect(deriveModelFit('codex', you, new Map(), USAGE('gpt-6-astra'), only('gpt-6-astra', 'gpt-6', 'o4-mini-deep-research'), 100).trial).toBeNull();
    // The same mix in ChatGPT's Chat tab may suggest gpt-6, which Chat offers.
    expect(deriveModelFit('chatgpt', you, new Map(), USAGE('gpt-6-astra'), only('gpt-6-astra', 'gpt-6', 'o4-mini-deep-research'), 100, ran('gpt-6-astra', 'chat')).trial?.toModel).toBe('gpt-6');
    // ChatGPT Work does not offer gpt-6, and nor does unknown (it must be offered in both).
    expect(deriveModelFit('chatgpt', you, new Map(), USAGE('gpt-6-astra'), only('gpt-6-astra', 'gpt-6', 'o4-mini-deep-research'), 100, ran('gpt-6-astra', 'work')).trial).toBeNull();
    expect(deriveModelFit('chatgpt', you, new Map(), USAGE('gpt-6-astra'), only('gpt-6-astra', 'gpt-6', 'o4-mini-deep-research'), 100).trial).toBeNull();
  });

  it('ChatGPT advice names only a model offered where the work ran, Chat or Work', () => {
    // Work on gpt-6.1-sol; colleagues reach deep work far more often on gpt-6-pro (Chat only)
    // and on gpt-6-astra (Work), both dearer per token.
    const you = new Map([['gpt-6.1-sol', tally(10, 1, 0.5, 1)]]);
    const proOnly = new Map([['gpt-6-pro', tally(MIN_ADVICE_SESSIONS, 5, 2, 3)]]);
    expect(deriveModelFit('chatgpt', you, proOnly, USAGE('gpt-6.1-sol'), RATES, 100, ran('gpt-6.1-sol', 'work')).advice).toBeNull();
    const both = new Map([...proOnly, ['gpt-6-astra', tally(MIN_ADVICE_SESSIONS, 5, 2, 3)]]);
    expect(deriveModelFit('chatgpt', you, both, USAGE('gpt-6.1-sol'), RATES, 100, ran('gpt-6.1-sol', 'work')).advice)
      .toMatchObject({ direction: 'step_up', toModel: 'gpt-6-astra' });

    // Chat on gpt-6-pro; colleagues' Work sessions on gpt-6.1-sol are a fifth of the price and do as well.
    const chat = new Map([['gpt-6-pro', tally(10, 1, 5, 3)]]);
    const sol = new Map([['gpt-6.1-sol', tally(MIN_ADVICE_SESSIONS, 5, 1, 3)]]);
    expect(deriveModelFit('chatgpt', chat, sol, USAGE('gpt-6-pro'), RATES, 100, ran('gpt-6-pro', 'chat')).advice?.toModel ?? null).not.toBe('gpt-6.1-sol');
    // The same person in ChatGPT Work is told to save with it.
    expect(deriveModelFit('chatgpt', chat, sol, USAGE('gpt-6-pro'), RATES, 100, ran('gpt-6-pro', 'work')).advice)
      .toMatchObject({ direction: 'save', toModel: 'gpt-6.1-sol' });
    // Work done in both: only a model both offer.
    expect(deriveModelFit('chatgpt', chat, sol, USAGE('gpt-6-pro'), RATES, 100, ran('gpt-6-pro', 'chat', 'work')).advice?.toModel ?? null).not.toBe('gpt-6.1-sol');
  });

  it('a Claude trial never suggests an OpenAI model, however cheap', () => {
    const you = new Map([['claude-opus-4-6', tally(10, 1, 5, 3)]]);
    const { trial } = deriveModelFit('cowork', you, new Map(), USAGE('claude-opus-4-6'), RATES, 100);
    expect(trial).not.toBeNull();
    expect(trial!.toModel.startsWith('claude-')).toBe(true);
  });

  it('colleagues on another vendor never become a save', () => {
    const you = new Map([['claude-opus-4-6', tally(10, 1, 5, 3)]]);
    const colleagues = new Map([['gpt-6.1-terra', tally(MIN_ADVICE_SESSIONS, 5, 0.5, 3)]]);
    const { advice } = deriveModelFit('cowork', you, colleagues, USAGE('claude-opus-4-6'), RATES, 100);
    expect(advice?.toModel ?? null).not.toBe('gpt-6.1-terra');
  });
});
