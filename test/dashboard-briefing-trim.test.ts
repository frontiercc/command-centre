// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { trimDashboardBriefing } from '@/lib/anthropic/dashboard-briefing-trim';

// A stand-in for the grounding check: text mentioning 67 carries an unchecked number.
const isClean = (t: string) => !/\b67\b/.test(t);

const rec = (title: string, detail: string) => ({ priority: 'medium', title, detail, category: 'governance' });

const base = {
  briefing: '76 people used Claude this week. 67 alerts look serious. Ten use cases are in regular use.',
  risk_score: 40,
  risk_label: 'moderate',
  risk_reasoning: 'Alerts are mostly low severity. 67 need a look.',
  adoption_headline: '76 active users, up 1% on last week.',
  recommendations: [
    rec('Close resolved alerts', '266 alerts are open. Close the handled ones.'),
    rec('Review 67 alerts', 'Look at them.'),
    rec('Grow Cowork use', 'Share the top skills.'),
    rec('Price unpriced models', 'Add the rate.'),
  ],
};

describe('trimDashboardBriefing', () => {
  it('drops only the sentences and recommendations that carry an unchecked number', () => {
    const out = trimDashboardBriefing(base, isClean)!;
    expect(out.briefing).toBe('76 people used Claude this week. Ten use cases are in regular use.');
    expect(out.risk_reasoning).toBe('Alerts are mostly low severity.');
    expect(out.adoption_headline).toBe(base.adoption_headline);
    expect(out.recommendations.map(r => r.title)).toEqual(['Close resolved alerts', 'Grow Cowork use', 'Price unpriced models']);
    expect(out.risk_score).toBe(40);
  });

  it('blanks a headline that carries an unchecked number', () => {
    const out = trimDashboardBriefing({ ...base, adoption_headline: '67 new users.' }, isClean)!;
    expect(out.adoption_headline).toBe('');
  });

  it('gives up when too few briefing sentences survive', () => {
    expect(trimDashboardBriefing({ ...base, briefing: '67 alerts. 76 users.' }, isClean)).toBeNull();
  });

  it('gives up when fewer than three recommendations survive', () => {
    const recs = [rec('A', '67 things.'), rec('B', 'Fine.'), rec('C', 'Also 67.')];
    expect(trimDashboardBriefing({ ...base, recommendations: recs }, isClean)).toBeNull();
  });
});
