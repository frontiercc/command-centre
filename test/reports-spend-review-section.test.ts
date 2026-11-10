// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Report: Spend Review section (pure renderer, fixtures, no DB). Every number
// comes from the input; individuals are named (admin/manager-only section);
// unpriced spend never reads $0; the month is stated when the report window
// differs; Anthropic limits appear only with an ok snapshot.
import { describe, it, expect } from 'vitest';
import { renderSpendReviewSection, routeSentence, monthElapsed, chooseEfficiencyBoards } from '@/lib/reports/spend-review-sections';
import { REPORT_SECTIONS, availableSections } from '@/lib/reports/section-catalog';
import { gapPct } from '@/lib/finance/spend-review-format';

const person = (over: Record<string, unknown>) => ({
  userId: 'u', displayName: 'Someone', email: null, department: 'Sales', codeUsd: 0, coworkUsd: 0, totalUsd: 0,
  priorTotalUsd: null, unpricedOnly: false, mainWork: null, routeCount: 0, ...over,
});

const save = { kind: 'model', direction: 'save', fromModel: 'claude-opus-5-5', toModel: 'claude-sonnet-5', metric: 'produced',
  from: { typicalSessionUsd: 0.63, rate: 0.21, basis: 'colleagues' }, to: { typicalSessionUsd: 0.71, rate: 0.31, people: 34, sessions: 113 },
  estSavingUsd: 66.17, priceRatio: 0.5, savingShare: 0.27 };

const index = {
  period: '2026-09',
  people: [
    person({ userId: 'g', displayName: 'Marco Rossi', totalUsd: 2118, priorTotalUsd: 1500, routeCount: 4, mainWork: { label: 'Basic Drafting', surface: 'cowork', share: 0.29 } }),
    person({ userId: 'n', displayName: 'No Price', totalUsd: 0, unpricedOnly: true }),
  ],
  efficiency: [{ userId: 'gb', displayName: 'Gabriel', department: 'Engineering', vsColleagues: 0.42, sessions: 275, deepRate: 0.12, peerDeepRate: 0.03 }],
  unpricedModels: [],
  summary: { totalUsd: 8449, priorTotalUsd: 6043, people: 106, halfSpendPeople: 6, topWork: [{ label: 'Basic Drafting', surface: 'cowork', share: 0.28 }], peopleWithRoutes: 92, orgRereadShare: 0.46 },
};

const reviews = [{
  displayName: 'Marco Rossi', totals: { totalUsd: 2118 },
  work: [{ label: 'Basic Drafting', share: 0.29, spendUsd: 614, routes: [save, { kind: 'context', rereadShare: 0.62, peerRereadShare: 0.37 }] }],
}];

const input = (over: Record<string, unknown> = {}) => ({ period: '2026-09', periodStart: '2026-09-01T00:00:00Z', periodEnd: '2026-09-30T23:59:59Z', index, reviews, limits: null, ...over }) as never;

describe('Spend Review report section', () => {
  it('names the biggest spenders and their better routes, with every figure from the data', () => {
    const md = renderSpendReviewSection(input());
    expect(md).toContain('### Spend Review: September 2026');
    expect(md).toContain('Total measured spend: **$8,449**, up 40% on last month, across 106 people.');
    expect(md).toContain('6 people account for half of it.');
    expect(md).toContain('46% of the month\'s cost is Claude re-reading');
    expect(md).toContain('| Marco Rossi | Sales | $2,118 | Basic Drafting (29%) | up 41% on last month | 4 |');
    expect(md).toContain('**Marco Rossi** ($2,118)');
    expect(md).toContain('save with Claude Sonnet 5 instead of Claude Opus 5.5: 50% of the price per token, backed by 113 colleague sessions of this work, about $66.17 (27% of this work) less at list price (estimate)');
    expect(md).toContain('long conversations: 62% of this cost is re-reading earlier conversation, against 37% for colleagues');
    expect(md).toContain('#### Most efficient on Claude in September 2026');
    expect(md).toContain('Scored on Claude Code and Cowork work only.');
    expect(md).toContain('| 1 | Gabriel | Engineering | 58% below | 275 | 12% vs 3% |');
    // A Claude-only hub: no OpenAI board.
    expect(md).not.toContain('Most efficient on ChatGPT and Codex');
  });

  it('never shows unpriced spend as $0', () => {
    const md = renderSpendReviewSection(input());
    expect(md).toContain('| No Price | Sales | not priced |');
  });

  it('says which month it covers when the report window is different', () => {
    const md = renderSpendReviewSection(input({ periodStart: '2026-08-15T00:00:00Z' }));
    expect(md).toContain("the month containing the report's end date");
  });

  it('adds Anthropic limits only with a working snapshot', () => {
    expect(renderSpendReviewSection(input())).not.toContain('Anthropic spend limits');
    const limits = {
      status: 'ok', fetchedAt: 1,
      members: [{ anthropicUserId: 'a', email: 'toby@x', name: 'Toby', rows: [{ period: 'monthly', limit: 500, spend: 520, currency: 'USD', source: 'Seat type default' }] }],
      pendingRequests: [{ id: 'r', anthropicUserId: 'a', email: 'toby@x', name: 'Toby', createdAt: '', period: 'monthly', summary: null }],
    };
    const md = renderSpendReviewSection(input({ limits }));
    expect(md).toContain('Over their limit: Toby ($520 of $500)');
    expect(md).toContain('Pending requests for more usage: Toby');
  });

  it('compares a month in progress with last month at the same pace', () => {
    // A tenth of the month gone: last month's $6,043 becomes $604 at the same pace.
    const md = renderSpendReviewSection(input({ pace: 0.1, index: { ...index, summary: { ...index.summary, totalUsd: 410 } } }));
    expect(md).toContain("Total measured spend: **$410**, down 32% on last month's pace, across 106 people.");
    expect(md).not.toContain('down 95%');
    expect(monthElapsed('2026-10', Date.UTC(2026, 9, 1, 12))).toBeCloseTo(0.5 / 31, 3);
    expect(monthElapsed('2026-09', Date.UTC(2026, 9, 1))).toBe(1);
  });

  it("shows last month's board, and says why, while this month has nobody ranked", () => {
    const md = renderSpendReviewSection(input({ period: '2026-10', index: { ...index, period: '2026-10', efficiency: [] }, boards: [{ vendor: 'claude', rows: index.efficiency, period: '2026-09' }] }));
    expect(md).toContain('#### Most efficient on Claude in September 2026');
    expect(md).toContain('Showing September 2026: nobody has 10 sessions of Claude work in October 2026 yet');
    expect(md).toContain('| 1 | Gabriel | Engineering | 58% below |');
    const own = renderSpendReviewSection(input());
    expect(own).toContain('#### Most efficient on Claude in September 2026');
    expect(own).not.toContain('Showing September 2026');
  });

  it('carries the Claude and OpenAI boards apart, each with its own fallback to last month', () => {
    const claudeNow = [{ userId: 'c1', displayName: 'Claude Now', department: 'Sales', vsColleagues: 0.5, sessions: 12, deepRate: 0.3, peerDeepRate: 0.3 }];
    const openaiLast = [{ userId: 'o1', displayName: 'OpenAI Last', department: 'Ops', vsColleagues: 0.8, sessions: 11, deepRate: 0.2, peerDeepRate: 0.25 }];
    const now = { openai: true, efficiency: claudeNow, efficiencyOpenai: [] };
    const prior = { period: '2026-09', openai: true, efficiency: [], efficiencyOpenai: openaiLast };
    const connected = { claude: true, openai: true };
    const boards = chooseEfficiencyBoards({ period: '2026-10', index: now as never, prior: prior as never, connected });
    expect(boards).toEqual([
      { vendor: 'claude', rows: claudeNow, period: '2026-10' },
      { vendor: 'openai', rows: openaiLast, period: '2026-09' },
    ]);
    const md = renderSpendReviewSection(input({ period: '2026-10', periodStart: '2026-10-01T00:00:00Z', periodEnd: '2026-10-31T23:59:59Z', boards }));
    expect(md).toContain('#### Most efficient on Claude in October 2026');
    expect(md).toContain('| 1 | Claude Now | Sales | 50% below | 12 | 30% vs 30% |');
    expect(md).toContain('#### Most efficient on ChatGPT and Codex in September 2026');
    expect(md).toContain('Showing September 2026: nobody has 10 sessions of ChatGPT and Codex work in October 2026 yet');
    expect(md).toContain('Scored on ChatGPT and Codex work only.');
    expect(md).toContain('| 1 | OpenAI Last | Ops | 20% below | 11 | 20% vs 25% |');
    // Claude's board comes first, and neither borrows the other's people.
    expect(md.indexOf('on Claude')).toBeLessThan(md.indexOf('on ChatGPT and Codex'));
    const claudeBlock = md.slice(md.indexOf('on Claude'), md.indexOf('on ChatGPT and Codex'));
    expect(claudeBlock).not.toContain('OpenAI Last');
  });

  it('shows OpenAI only when it is connected and shown, and OpenAI alone on an OpenAI-only hub', () => {
    const rows = [{ userId: 'x', displayName: 'X', department: null, vsColleagues: 0.5, sessions: 10, deepRate: 0.3, peerDeepRate: 0.3 }];
    const idx = { openai: false, efficiency: rows, efficiencyOpenai: rows };
    // Hidden on the OpenAI panel (openai false, no OpenAI spend shown): Claude's board only.
    expect(chooseEfficiencyBoards({ period: '2026-10', index: idx as never, prior: null, connected: { claude: true, openai: false, openaiConnected: true } }).map(b => b.vendor)).toEqual(['claude']);
    // Connected and shown: both.
    expect(chooseEfficiencyBoards({ period: '2026-10', index: idx as never, prior: null, connected: { claude: true, openai: true } }).map(b => b.vendor)).toEqual(['claude', 'openai']);
    // OpenAI only: OpenAI alone.
    const only = chooseEfficiencyBoards({ period: '2026-09', index: { ...idx, openai: true } as never, prior: null, connected: { claude: false, openai: true } });
    expect(only.map(b => b.vendor)).toEqual(['openai']);
    const md = renderSpendReviewSection(input({ boards: only }));
    expect(md).toContain('#### Most efficient on ChatGPT and Codex in September 2026');
    expect(md).not.toContain('Most efficient on Claude');
    // No fallback for a past month (no prior passed) and none when last month is empty too: the board is left out.
    const none = renderSpendReviewSection(input({ boards: [{ vendor: 'openai', rows: [], period: '2026-09' }] }));
    expect(none).not.toContain('Most efficient on');
  });

  it('shows a small gap to colleagues as it is, never rounded to 0%', () => {
    expect(gapPct(0.42)).toBe('58%');
    expect(gapPct(0.9978)).toBe('0.2%');
    expect(gapPct(0.9644)).toBe('3.6%');
    expect(gapPct(0.9004)).toBe('10%');
    expect(gapPct(0.9999)).toBe('under 0.1%');
    const close = { userId: 'ds', displayName: 'David', department: 'Consulting', vsColleagues: 0.9978, sessions: 14, deepRate: 0.21, peerDeepRate: 0.21 };
    const md = renderSpendReviewSection(input({ index: { ...index, efficiency: [close] } }));
    expect(md).toContain('| 1 | David | Consulting | 0.2% below | 14 | 21% vs 21% |');
  });

  it('adds a scheduled task running on a costly model to the better routes', () => {
    const task = { name: 'nightly-digest', surface: 'code', runs: 32, days: 25, spendUsd: 50.33, mainModel: 'claude-haiku-4-5', costlyShare: 0.58, costlyModel: 'claude-opus-5-5', cheaperFamilies: ['Sonnet', 'Haiku'] };
    const md = renderSpendReviewSection(input({ reviews: [{ ...reviews[0], scheduledTasks: [task] }] }));
    expect(md).toContain('Scheduled task nightly-digest (32 runs, $50.33): runs unattended with 58% of its cost on pricier models, mainly Claude Opus 5.5; routine work like this usually runs fine on Sonnet or Haiku.');
    const all = renderSpendReviewSection(input({ reviews: [{ ...reviews[0], scheduledTasks: [{ ...task, mainModel: 'claude-opus-5-5', costlyShare: 1 }] }] }));
    expect(all).toContain('runs unattended with all of its cost on Claude Opus 5.5;');
  });

  it('describes a trial as untested', () => {
    expect(routeSentence({ ...save, direction: 'trial', toModel: 'claude-haiku-4-5', priceRatio: 0.25 } as never)).toContain('too few colleagues use it for this work to show results');
  });

  it('is offered only with FinOps on, and only to admins and managers', () => {
    const def = REPORT_SECTIONS.find(s => s.id === 'spend_review')!;
    expect(def).toMatchObject({ requiresFlag: 'chargebackEnabled', managerOnly: true, default: false });
    const ids = (flags: Record<string, boolean>, mgr: boolean) => availableSections(flags as never, mgr).map(s => s.id);
    expect(ids({ chargebackEnabled: true }, true)).toContain('spend_review');
    expect(ids({ chargebackEnabled: true }, false)).not.toContain('spend_review');
    expect(ids({ chargebackEnabled: false }, true)).not.toContain('spend_review');
  });
});
