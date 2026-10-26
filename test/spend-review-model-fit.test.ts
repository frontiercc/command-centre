// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Spend Review model advice (pure). The rules, after a production deployment's real data
//: a suggested model needs MIN_ADVICE_SESSIONS colleague sessions
// (Fable 5.1's 5 sessions must never beat Opus 5.5's 53); cheaper or dearer is
// judged on per-token list price, not cost per session (Sonnet 5, at half Opus
// 5.5's price, looked dearer per session because its sessions were bigger);
// and with no evidence either way, a much cheaper model is offered as a
// clearly labelled trial. Plus the built-in tool list and index helpers.
import { describe, it, expect } from 'vitest';
import {
  deriveModelFit, newTally, tallySession, halfSpendCount, priorPeriod,
  SAVE_MAX_OUTCOME_DROP, STEP_UP_MIN_OUTCOME_GAIN, MIN_SAVE_USD, MIN_ADVICE_SESSIONS, savingWorthIt,
  contextAdvice, REREAD_SHARE_MIN, REREAD_ABOVE_PEERS, efficiencyRatio, keepsDepth,
} from '@/lib/finance/spend-review';
import { isBuiltInTool } from '@/lib/finance/spend-review-builtins';
import { DEFAULT_RATES } from '@/lib/pulse/code/rates';

type Session = { spend: number; produced: boolean | null; tier: number | null };

/** A tally of `n` sessions spread over `people` people. */
function tally(n: number, people: number, s: (i: number) => Session) {
  const t = newTally();
  for (let i = 0; i < n; i++) tallySession(t, { userId: `u${i % people}`, ...s(i) });
  return t;
}

/** A month of the person's usage on one model: 10M input + 1M output tokens. */
const USAGE = (m: string) => new Map([[m, { inputTokens: 10_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0 }]]);
const N = MIN_ADVICE_SESSIONS;

const OPUS = 'claude-opus-4-6';      // $5 / $25
const SONNET = 'claude-sonnet-4-6';  // $3 / $15 — 60% of Opus
const HAIKU = 'claude-haiku-4-5';    // $1 / $5 — 20% of Opus
const FABLE = 'claude-fable-5-1';    // $10 / $50 — twice Opus

/** Rates with only the models a test names, so the trial candidate is predictable. */
function rates(...models: string[]) {
  return Object.fromEntries(models.map(m => [m, DEFAULT_RATES[m] ?? { in: 0, out: 0, cacheWrite: 0, cacheRead: 0 }]));
}

describe('deriveModelFit', () => {
  it('saves with a model that is clearly cheaper per token and does as well', () => {
    const you = new Map([[OPUS, tally(6, 1, () => ({ spend: 5, produced: true, tier: 2 }))]]);
    const colleagues = new Map([
      [OPUS, tally(N, 4, i => ({ spend: 5, produced: i < N * 0.6, tier: 2 }))],
      [SONNET, tally(N, 4, i => ({ spend: 1, produced: i < N * 0.6, tier: 2 }))],
    ]);
    const { rows, advice } = deriveModelFit('cowork', you, colleagues, USAGE(OPUS), rates(OPUS, SONNET));
    expect(rows.map(r => r.model)).toEqual([OPUS, SONNET]); // dearest first
    expect(advice).toMatchObject({ direction: 'save', fromModel: OPUS, toModel: SONNET, metric: 'produced', from: { basis: 'colleagues', rate: 0.6 }, to: { people: 4, rate: 0.6, sessions: N } });
    expect(advice!.priceRatio).toBeCloseTo(0.6, 6);
    expect(advice!.estSavingUsd).toBeGreaterThanOrEqual(MIN_SAVE_USD);
  });

  it("saves on price even when colleagues' sessions on the cheaper model are bigger (the Sonnet 5 case)", () => {
    const you = new Map([[OPUS, tally(3, 1, () => ({ spend: 3, produced: false, tier: 2 }))]]);
    const colleagues = new Map([
      [OPUS, tally(N, 5, i => ({ spend: 0.6, produced: i < N * 0.2, tier: 2 }))],   // $0.60 a session, 20%
      [SONNET, tally(N, 5, i => ({ spend: 0.7, produced: i < N * 0.3, tier: 2 }))], // $0.70 a session, 30%
    ]);
    expect(deriveModelFit('cowork', you, colleagues, USAGE(OPUS), rates(OPUS, SONNET)).advice).toMatchObject({ direction: 'save', toModel: SONNET });
  });

  it('never suggests a model on a handful of sessions, however good they look (the Fable 5.1 case)', () => {
    const you = new Map([[OPUS, tally(3, 1, () => ({ spend: 3, produced: false, tier: 2 }))]]);
    const colleagues = new Map([
      [OPUS, tally(53, 19, i => ({ spend: 0.6, produced: i < 11, tier: 2 }))], // 21%
      [FABLE, tally(5, 3, i => ({ spend: 4, produced: i < 2, tier: 2 }))],     // 40%, 5 sessions
    ]);
    const { advice } = deriveModelFit('cowork', you, colleagues, USAGE(OPUS), rates(OPUS, FABLE));
    expect(advice?.toModel).not.toBe(FABLE);
  });

  it('does not save with a cheaper model whose results are clearly worse', () => {
    const you = new Map([[OPUS, tally(6, 1, () => ({ spend: 5, produced: true, tier: 2 }))]]);
    const worse = Math.round(N * (0.6 - SAVE_MAX_OUTCOME_DROP - 0.1));
    const colleagues = new Map([
      [OPUS, tally(N, 4, i => ({ spend: 5, produced: i < N * 0.6, tier: 2 }))],
      [SONNET, tally(N, 4, i => ({ spend: 1, produced: i < worse, tier: 2 }))],
    ]);
    expect(deriveModelFit('cowork', you, colleagues, USAGE(OPUS), rates(OPUS, SONNET)).advice).toBeNull();
  });

  it('steps up to a clearly bigger model that colleagues get clearly more from', () => {
    const you = new Map([[HAIKU, tally(8, 1, () => ({ spend: 0.2, produced: null, tier: 1 }))]]);
    const colleagues = new Map([
      [HAIKU, tally(N, 3, i => ({ spend: 0.2, produced: null, tier: i < N * 0.1 ? 3 : 1 }))],  // 10% deep
      [SONNET, tally(N, 3, i => ({ spend: 0.8, produced: null, tier: i < N * 0.4 ? 3 : 2 }))], // 40% deep
    ]);
    const { advice } = deriveModelFit('code', you, colleagues, USAGE(HAIKU), rates(HAIKU, SONNET));
    expect(advice).toMatchObject({ direction: 'step_up', fromModel: HAIKU, toModel: SONNET, metric: 'deep', to: { sessions: N } });
    expect(advice!.to.rate! - advice!.from.rate!).toBeGreaterThanOrEqual(STEP_UP_MIN_OUTCOME_GAIN);
  });

  it('never steps up to a model of about the same price, even with better outcomes', () => {
    // Opus 4.6 and Opus 4.8 cost the same per token: a sibling, not a bigger model.
    const you = new Map([[OPUS, tally(8, 1, () => ({ spend: 2, produced: null, tier: 1 }))]]);
    const colleagues = new Map([
      [OPUS, tally(N, 3, () => ({ spend: 2, produced: null, tier: 1 }))],
      ['claude-opus-4-8', tally(N, 3, () => ({ spend: 2, produced: null, tier: 3 }))],
    ]);
    expect(deriveModelFit('code', you, colleagues, USAGE(OPUS), rates(OPUS, 'claude-opus-4-8')).advice).toBeNull();
  });

  it('offers a much cheaper model as a labelled trial when colleagues give no evidence either way', () => {
    const you = new Map([[OPUS, tally(4, 1, () => ({ spend: 3, produced: false, tier: 2 }))]]);
    const { advice, trial } = deriveModelFit('cowork', you, new Map(), USAGE(OPUS), rates(OPUS, SONNET, HAIKU, '<synthetic>'));
    expect(advice).toBeNull();
    expect(trial).toMatchObject({ direction: 'trial', fromModel: OPUS, toModel: HAIKU, metric: null });
    expect(trial!.priceRatio).toBeCloseTo(0.2, 6);
    expect(trial!.estSavingUsd).toBeGreaterThanOrEqual(MIN_SAVE_USD);
  });

  it('prefers a proven cheaper model to an untested trial early in the month (the Marco case)', () => {
    // Under $5 saved so far this month, but over a quarter of the work's spend: still worth saying.
    const you = new Map([[OPUS, tally(3, 1, () => ({ spend: 2.9, produced: false, tier: 2 }))]]);
    const colleagues = new Map([
      [OPUS, tally(53, 19, i => ({ spend: 0.6, produced: i < 11, tier: 2 }))],
      [SONNET, tally(113, 34, i => ({ spend: 0.7, produced: i < 35, tier: 2 }))],
    ]);
    const small = new Map([[OPUS, { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheCreationTokens: 0 }]]);
    const { advice, trial } = deriveModelFit('cowork', you, colleagues, small, rates(OPUS, SONNET, HAIKU), 8.7);
    expect(advice).toMatchObject({ direction: 'save', toModel: SONNET });
    expect(advice!.estSavingUsd).toBeLessThan(MIN_SAVE_USD);
    expect(advice!.savingShare).toBeCloseTo(advice!.estSavingUsd! / 8.7, 6);
    // A proven save is the advice: no untested trial beside it.
    expect(trial).toBeNull();
  });

  it('offers no trial when a cheaper model is already proven', () => {
    const you = new Map([[OPUS, tally(6, 1, () => ({ spend: 5, produced: true, tier: 2 }))]]);
    const colleagues = new Map([
      [OPUS, tally(N, 4, i => ({ spend: 5, produced: i < N * 0.6, tier: 2 }))],
      [SONNET, tally(N, 4, i => ({ spend: 1, produced: i < N * 0.6, tier: 2 }))],
    ]);
    const { advice, trial } = deriveModelFit('cowork', you, colleagues, USAGE(OPUS), rates(OPUS, SONNET, HAIKU));
    expect(advice).toMatchObject({ direction: 'save', toModel: SONNET });
    expect(trial).toBeNull();
  });

  it('suggests nothing when the saving would be under the monthly minimum', () => {
    const you = new Map([[OPUS, tally(6, 1, () => ({ spend: 5, produced: true, tier: 2 }))]]);
    const colleagues = new Map([
      [OPUS, tally(N, 4, i => ({ spend: 5, produced: i < N * 0.6, tier: 2 }))],
      [SONNET, tally(N, 4, i => ({ spend: 1, produced: i < N * 0.6, tier: 2 }))],
    ]);
    const tiny = new Map([[OPUS, { inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 0, cacheCreationTokens: 0 }]]);
    expect(deriveModelFit('cowork', you, colleagues, tiny, rates(OPUS, SONNET, HAIKU)).advice).toBeNull();
  });

  it('does not claim outcomes are as good when neither model reached them', () => {
    const you = new Map([[OPUS, tally(6, 1, () => ({ spend: 5, produced: false, tier: 1 }))]]);
    const colleagues = new Map([
      [OPUS, tally(N, 4, () => ({ spend: 5, produced: false, tier: 1 }))],
      [SONNET, tally(N, 4, () => ({ spend: 1, produced: false, tier: 1 }))],
    ]);
    expect(deriveModelFit('cowork', you, colleagues, USAGE(OPUS), rates(OPUS, SONNET)).advice).toMatchObject({ direction: 'save', metric: null });
  });

  it('hides a model fewer than three colleagues used, and never suggests it on that basis', () => {
    const you = new Map([[OPUS, tally(6, 1, () => ({ spend: 5, produced: true, tier: 2 }))]]);
    const colleagues = new Map([[SONNET, tally(N, 2, () => ({ spend: 1, produced: true, tier: 2 }))]]);
    const { rows, advice } = deriveModelFit('cowork', you, colleagues, USAGE(OPUS), rates(OPUS, SONNET));
    expect(rows.map(r => r.model)).toEqual([OPUS]);
    expect(advice?.direction).not.toBe('save');
  });
});

describe('contextAdvice', () => {
  // 57M cache-read tokens against 0.2M written: the Marco shape (~62% re-reading at Opus 5 rates).
  const heavy = new Map([['claude-opus-5', { inputTokens: 40_000, outputTokens: 200_000, cacheCreationTokens: 1_900_000, cacheReadTokens: 57_000_000 }]]);
  const typical = new Map([['claude-opus-5', { inputTokens: 40_000, outputTokens: 200_000, cacheCreationTokens: 1_900_000, cacheReadTokens: 15_000_000 }]]);
  it('flags someone who re-reads clearly more than colleagues doing the same work', () => {
    const r = contextAdvice(heavy, typical, rates('claude-opus-5'));
    expect(r?.kind).toBe('context');
    expect(r!.rereadShare).toBeGreaterThanOrEqual(REREAD_SHARE_MIN);
    expect(r!.rereadShare - r!.peerRereadShare).toBeGreaterThanOrEqual(REREAD_ABOVE_PEERS);
  });
  it('stays quiet when colleagues re-read just as much (it is how Cowork works)', () => {
    expect(contextAdvice(heavy, heavy, rates('claude-opus-5'))).toBeNull();
  });
  it('stays quiet when re-reading is a minority of the cost, or with no colleagues to compare', () => {
    expect(contextAdvice(USAGE(OPUS), new Map(), rates(OPUS))).toBeNull();
    expect(contextAdvice(heavy, null, rates('claude-opus-5'))).toBeNull();
  });
});

describe('savingWorthIt', () => {
  it('takes $5, or a fifth of the work, never under $1', () => {
    expect(savingWorthIt(5, null)).toBe(true);
    expect(savingWorthIt(3, 10)).toBe(true);    // 30% of the work
    expect(savingWorthIt(2, 10)).toBe(true);    // 20%
    expect(savingWorthIt(1.5, 10)).toBe(false); // 15%
    expect(savingWorthIt(0.9, 2)).toBe(false);  // under $1 even at 45%
    expect(savingWorthIt(null, 10)).toBe(false);
  });
});

describe('built-in tools', () => {
  it("never offers Claude's own connectors or skills, however they are spelt", () => {
    expect(isBuiltInTool('connector', 'memory')).toBe(true);
    expect(isBuiltInTool('connector', 'remote-devices')).toBe(true);
    expect(isBuiltInTool('connector', 'Claude Browser')).toBe(true);
    expect(isBuiltInTool('connector', 'session_info')).toBe(true);
    expect(isBuiltInTool('skill', 'artifact-design')).toBe(true);
    expect(isBuiltInTool('skill', 'run')).toBe(true);
  });
  it('keeps real connectors and org skills', () => {
    expect(isBuiltInTool('connector', 'Google_Drive')).toBe(false);
    expect(isBuiltInTool('connector', 'Slack')).toBe(false);
    expect(isBuiltInTool('connector', 'claude-in-chrome')).toBe(false);
    expect(isBuiltInTool('skill', 'acme-slides:acme-slides')).toBe(false);
    expect(isBuiltInTool('skill', 'anthropic-skills:xlsx')).toBe(false);
  });
});

describe('efficiencyRatio', () => {
  it('compares each kind of work with colleagues doing it, weighted by spend', () => {
    // $80 on work at half colleagues' typical cost, $20 on work at twice it: 0.8*0.5 + 0.2*2 = 0.8.
    expect(efficiencyRatio([
      { spend: 80, personMedian: 1, peerMedian: 2 },
      { spend: 20, personMedian: 4, peerMedian: 2 },
    ])).toBeCloseTo(0.8, 6);
  });
  it("only ranks work that stayed as deep as colleagues' (cheaper because shallower does not count)", () => {
    expect(keepsDepth(0.12, 0.03)).toBe(true);
    expect(keepsDepth(0.31, 0.36)).toBe(true);
    expect(keepsDepth(0, 0.25)).toBe(false);
    expect(keepsDepth(null, 0.2)).toBe(false);
  });
  it('ignores work with nothing to compare, and is null when nothing compares', () => {
    expect(efficiencyRatio([{ spend: 50, personMedian: 1, peerMedian: null }, { spend: 50, personMedian: 3, peerMedian: 2 }])).toBeCloseTo(1.5, 6);
    expect(efficiencyRatio([{ spend: 50, personMedian: null, peerMedian: 2 }])).toBeNull();
  });
});

describe('index helpers', () => {
  it('counts the fewest people making up half of spend', () => {
    expect(halfSpendCount([50, 30, 10, 10])).toBe(1);
    expect(halfSpendCount([30, 30, 20, 20])).toBe(2);
    expect(halfSpendCount([10, 10, 10])).toBeNull(); // under four people
  });
  it('steps back one month across a year end', () => {
    expect(priorPeriod('2026-01')).toBe('2025-12');
    expect(priorPeriod('2026-10')).toBe('2026-09');
  });
});
