// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Coaching opportunities digest section — counts-only.
 *
 * DigestData.coaching is produced exclusively by
 * lib/usecases/spread.ts's getCoachingCountsByDept(), which returns
 * {dept, count} pairs ONLY (no user ids/display names ever leave that
 * module). This file is fixture-only (no DB) and proves the renderers
 * surface the counts correctly; its "shape" test below asserts the
 * serialized regex/marker-absence against a HAND-BUILT fixture object
 * (`fullData()`), so it is tautological about the real builder — it
 * would pass even if getCoachingCountsByDept started returning extra
 * fields, since this file never calls it. The REAL structural guard on
 * the builder's actual output is test/usecases-spread-db.test.ts (see
 * its `Object.keys(counts[0]).sort()).toEqual(['count', 'dept'])`
 * assertion), which runs getCoachingCountsByDept against a real DB and
 * checks its return shape directly. The regex/marker assertions here
 * are kept anyway as a cheap DB-free regression check on the renderers.
 */
import { describe, it, expect } from 'vitest';
import { renderDigestHtml, renderDigestSlack } from '@/lib/digest/render';
import type { DigestData } from '@/lib/digest/build';

const HUB_URL = 'https://ccc.example.com';
const DAY = 86400;
const WEEK = 7 * DAY;

const WEEK_START = Date.UTC(2026, 5, 22) / 1000; // 2026-06-22 (Mon)
const WEEK_END = WEEK_START + WEEK;

function fullData(overrides: Partial<DigestData> = {}): DigestData {
  return {
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
    code: {
      spendUsd: 1234.5,
      spendDeltaPct: 0.12,
      spendIsPartlyEstimated: false,
      unpricedModelCount: 0,
      commits: 42,
      prs: 7,
      engagedHours: 88.5,
      activeUsers: 12,
    },
    cowork: null,
    anomaly: {
      // Marker string proves the structural assertion below actually
      // bites: if coaching ever leaked unrelated DigestData content,
      // this marker would show up inside the stringified coaching too.
      title: 'MARKER_ANOMALY_TITLE',
      severity: 'high',
      occurredAt: WEEK_START + DAY,
      userLinked: false,
    },
    briefingExcerpt: 'MARKER_BRIEFING_EXCERPT',
    useCases: {
      atRisk: [{ title: 'MARKER_USE_CASE_TITLE', owner: 'MARKER_OWNER_NAME', quietWeeks: 3 }],
      newlyAdopted: [],
      newlyAtRisk: [],
    },
    coaching: [{ dept: 'Finance', count: 3 }],
    ...overrides,
  };
}

describe('coaching opportunities — digest builder shape', () => {
  it('is counts-only: JSON.stringify(coaching) matches the locked {dept,count} shape', () => {
    const data = fullData();
    const serialized = JSON.stringify(data.coaching);
    expect(serialized).toMatch(/^\[\{"dept":"[^"]+","count":\d+\}/);
  });

  it('never carries unrelated DigestData content (marker strings absent from the coaching payload)', () => {
    const data = fullData();
    const serialized = JSON.stringify(data.coaching);
    expect(serialized).not.toContain('MARKER_ANOMALY_TITLE');
    expect(serialized).not.toContain('MARKER_BRIEFING_EXCERPT');
    expect(serialized).not.toContain('MARKER_USE_CASE_TITLE');
    expect(serialized).not.toContain('MARKER_OWNER_NAME');
  });
});

describe('coaching opportunities — HTML render', () => {
  it('renders a dept + pluralised count line when coaching is present', () => {
    const html = renderDigestHtml(fullData(), HUB_URL);
    expect(html).toContain('Finance');
    expect(html).toContain('3 coaching opportunities');
  });

  it('pluralises singular counts correctly ("1 coaching opportunity")', () => {
    const html = renderDigestHtml(fullData({ coaching: [{ dept: 'Legal', count: 1 }] }), HUB_URL);
    expect(html).toContain('1 coaching opportunity');
    expect(html).not.toContain('1 coaching opportunities');
  });

  it('omits the section entirely when coaching is null', () => {
    const html = renderDigestHtml(fullData({ coaching: null }), HUB_URL);
    expect(html).not.toContain('coaching opportunit');
    expect(html).not.toContain('Coaching opportunities');
  });
});

describe('coaching opportunities — Slack render', () => {
  it('renders the same dept + pluralised count content', () => {
    const payload = renderDigestSlack(fullData(), HUB_URL);
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain('Finance');
    expect(serialized).toContain('3 coaching opportunities');
  });

  it('omits the block entirely when coaching is null', () => {
    const payload = renderDigestSlack(fullData({ coaching: null }), HUB_URL);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('coaching opportunit');
    expect(serialized).not.toContain('Coaching opportunities');
  });
});
