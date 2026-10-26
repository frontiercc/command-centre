// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { renderHighlightsPost } from '@/lib/highlights/render';
import type { HighlightsInput } from '@/lib/highlights/gather';
import type { ComposedHighlights } from '@/lib/highlights/compose';

const composed: ComposedHighlights = {
  subject: 'client proposals and budget reconciliation',
  deliverables: [
    { itemIndex: 0, sentence: 'A client-ready proposal deck — from nothing but a meeting recording.' },
    { itemIndex: 1, sentence: 'A reconciled monthly budget with every variance explained.' },
  ],
};

function makeInput(overrides: Partial<HighlightsInput> = {}): HighlightsInput {
  return {
    weekStart: 1753056000, weekEnd: 1753660800,
    headcount: 14,
    workItems: [
      { index: 0, taskType: 'workflow', text: 'x' },
      { index: 1, taskType: 'analysis', text: 'y' },
    ],
    engineeringMix: [{ workType: 'feature_dev', sessions: 12 }, { workType: 'debugging', sessions: 5 }],
    systems: { totalCalls: 87, distinctSystems: 6, top: [{ server: 'salesforce', calls: 40, people: 4 }, { server: 'slack', calls: 20, people: 3 }] },
    codeOutput: { linesChanged: 5400, handsOnHours: 21, changesKept: 310, changesProposed: 350, basis: 'week' },
    tier3Count: 9,
    shoutouts: null,
    ...overrides,
  };
}

describe('renderHighlightsPost', () => {
  it('assembles the full post with every number from the input', () => {
    const post = renderHighlightsPost(makeInput(), composed);
    expect(post).toContain('A client-ready proposal deck');
    expect(post).toContain('14'); // headcount
    expect(post).toContain('client proposals and budget reconciliation');
    expect(post).toContain('17 sessions'); // engineering total 12+5
    expect(post).toContain('87 times');
    expect(post).toContain('5,400 lines');
    expect(post).toContain('310 of the 350');
    expect(post).toContain('9 pieces of work');
    expect(post).not.toContain('*');       // no asterisks — Slack renders them literally
    expect(post).not.toContain('undefined');
  });

  it('omits sections with no data', () => {
    const post = renderHighlightsPost(makeInput({ engineeringMix: [], codeOutput: null, systems: { totalCalls: 0, distinctSystems: 0, top: [] }, tier3Count: 0 }), composed);
    expect(post).not.toContain(':mag:');
    expect(post).not.toContain(':computer:');
    expect(post).not.toContain(':electric_plug:');
    expect(post).not.toContain(':dart:');
    expect(post).toContain('A client-ready proposal deck'); // deliverables always render
  });

  it('renders shout-outs only when present', () => {
    expect(renderHighlightsPost(makeInput(), composed)).not.toContain('Special mention');
    const withNames = makeInput({ shoutouts: {
      systems: { person: 'Joana Reis', count: 31, distinct: 5 },
      skills: { person: 'Sam Roe', count: 12, distinct: 4 },
    }});
    const post = renderHighlightsPost(withNames, composed);
    expect(post).toContain('Special mention to @Joana Reis');
    expect(post).toContain('@Sam Roe');
  });

  it('labels code output as rolling ("over the last 30 days") when basis is rolling', () => {
    const post = renderHighlightsPost(makeInput({ codeOutput: { linesChanged: 5400, handsOnHours: 21, changesKept: 310, changesProposed: 350, basis: 'rolling' } }), composed);
    expect(post.toLowerCase()).toContain('over the last 30 days');
    expect(post).toContain('5,400 lines');
    expect(post).toContain('21 hours');
    expect(post).toContain('310 of the 350');
  });

  it('does not mention "30 days" when code output basis is week', () => {
    const post = renderHighlightsPost(makeInput({ codeOutput: { linesChanged: 5400, handsOnHours: 21, changesKept: 310, changesProposed: 350, basis: 'week' } }), composed);
    expect(post.toLowerCase()).not.toContain('30 days');
  });
});
