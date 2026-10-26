// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { renderDigestHtml, renderDigestSlack } from '@/lib/digest/render';
import type { DigestData } from '@/lib/digest/build';

const HUB_URL = 'https://ccc.example.com';
const DAY = 86400;
const WEEK = 7 * DAY;

// A fixed Monday 00:00 UTC for deterministic date-range formatting.
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
    cowork: {
      classifiedEvents: 512,
      eventsDeltaPct: -0.05,
      tier3Count: 30,
      tier3DeltaPct: 0.2,
      activeUsers: 20,
    },
    anomaly: { title: 'Unusual spend spike', severity: 'high', occurredAt: WEEK_START + DAY, userLinked: false },
    briefingExcerpt: 'This week the team shipped a record number of PRs.',
    useCases: null,
    coaching: null,
    ...overrides,
  };
}

describe('renderDigestHtml', () => {
  it('contains the key strings for a full data set', () => {
    const html = renderDigestHtml(fullData(), HUB_URL);

    expect(html).toContain('1,234.50'); // spend, formatted
    expect(html).toContain('vs last completed week (Mon–Sun)');
    expect(html).toContain('Unusual spend spike');
    expect(html).toContain(`${HUB_URL}/pulse/code`);
    expect(html).toContain('Open Command Centre');
    expect(html).toContain('This week the team shipped a record number of PRs.');
  });

  it('renders inline styles only, no <style> blocks', () => {
    const html = renderDigestHtml(fullData(), HUB_URL);
    expect(html).not.toMatch(/<style/i);
    expect(html).toMatch(/style="/);
  });

  it('shows an em dash, never $0.00, when spend is null', () => {
    const data = fullData({
      code: {
        spendUsd: null,
        spendDeltaPct: null,
        spendIsPartlyEstimated: false,
        unpricedModelCount: 3,
        commits: 5,
        prs: 1,
        engagedHours: null,
        activeUsers: 2,
      },
    });
    const html = renderDigestHtml(data, HUB_URL);

    expect(html).toContain('—');
    expect(html).not.toContain('$0.00');
    expect(html).not.toContain('$0');
    // unpriced caveat
    expect(html).toContain('excludes 3 unpriced models');
  });

  it('omits the arrow/comparison phrase entirely when deltas are null', () => {
    const data = fullData({
      code: {
        spendUsd: 500,
        spendDeltaPct: null,
        spendIsPartlyEstimated: false,
        unpricedModelCount: 0,
        commits: 5,
        prs: 1,
        engagedHours: 10,
        activeUsers: 2,
      },
      cowork: {
        classifiedEvents: 10,
        eventsDeltaPct: null,
        tier3Count: 1,
        tier3DeltaPct: null,
        activeUsers: 2,
      },
    });
    const html = renderDigestHtml(data, HUB_URL);
    expect(html).not.toContain('vs last completed week');
  });

  it('omits the Cowork section entirely when cowork data is null (code-only)', () => {
    const data = fullData({ cowork: null });
    const html = renderDigestHtml(data, HUB_URL);

    expect(html).not.toContain('Cowork');
    expect(html).not.toMatch(/\btier/i); // the word, not the "tier" in "Frontier"
  });

  it('omits the Code section entirely when code data is null (cowork-only)', () => {
    const data = fullData({ code: null });
    const html = renderDigestHtml(data, HUB_URL);

    expect(html).not.toContain('Developer Pulse');
    expect(html).not.toContain('engaged');
  });

  it('omits the anomaly callout when there is no anomaly', () => {
    const data = fullData({ anomaly: null });
    const html = renderDigestHtml(data, HUB_URL);
    expect(html).not.toContain('Unusual spend spike');
  });

  it('omits the briefing excerpt block when there is no briefing', () => {
    const data = fullData({ briefingExcerpt: null });
    const html = renderDigestHtml(data, HUB_URL);
    expect(html).not.toContain('This week the team shipped');
  });

  it('shows the estimate caveat only when spendIsPartlyEstimated is true', () => {
    const withEstimate = fullData({
      code: {
        spendUsd: 800,
        spendDeltaPct: 0.1,
        spendIsPartlyEstimated: true,
        unpricedModelCount: 0,
        commits: 5,
        prs: 1,
        engagedHours: 10,
        activeUsers: 2,
      },
    });
    const html = renderDigestHtml(withEstimate, HUB_URL);
    expect(html).toContain('includes provider-routed usage estimated at list pricing');

    const without = fullData();
    const htmlWithout = renderDigestHtml(without, HUB_URL);
    expect(htmlWithout).not.toContain('includes provider-routed usage estimated at list pricing');
  });

  it('escapes HTML-injection attempts in the anomaly title', () => {
    const data = fullData({
      anomaly: { title: '<script>alert(1)</script>', severity: 'high', occurredAt: WEEK_START + DAY, userLinked: false },
    });
    const html = renderDigestHtml(data, HUB_URL);

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes HTML-injection attempts in the briefing excerpt', () => {
    const data = fullData({ briefingExcerpt: '<img src=x onerror=alert(1)>' });
    const html = renderDigestHtml(data, HUB_URL);

    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('formats the header date range as Mon–Sun', () => {
    const html = renderDigestHtml(fullData(), HUB_URL);
    // WEEK_START = 2026-06-22 (Mon), WEEK_END - 1 day = 2026-06-28 (Sun)
    expect(html).toMatch(/Jun(e)?\s+22/);
    expect(html).toMatch(/Jun(e)?\s+28/);
  });

  it('omits the "Use cases needing attention" section when useCases is null', () => {
    const html = renderDigestHtml(fullData({ useCases: null }), HUB_URL);
    expect(html).not.toContain('Use cases needing attention');
  });

  it('renders at-risk, newly-adopted and newly-at-risk use cases when present', () => {
    const data = fullData({
      useCases: {
        atRisk: [{ title: 'Contract triage', owner: 'sam.taylor@example.com', quietWeeks: 3 }],
        newlyAdopted: ['Meeting notes summarisation'],
        newlyAtRisk: ['Invoice matching'],
      },
    });
    const html = renderDigestHtml(data, HUB_URL);

    expect(html).toContain('Use cases needing attention');
    expect(html).toContain('Contract triage');
    expect(html).toContain('3 quiet weeks');
    expect(html).toContain('sam.taylor@example.com');
    expect(html).toContain('Meeting notes summarisation');
    expect(html).toContain('now adopted');
    expect(html).toContain('Invoice matching');
    expect(html).toContain('now at risk');
  });
});

describe('renderDigestSlack', () => {
  it('produces a valid blocks payload for a full data set', () => {
    const payload = renderDigestSlack(fullData(), HUB_URL) as { blocks: unknown[] };

    expect(Array.isArray(payload.blocks)).toBe(true);
    expect(payload.blocks.length).toBeGreaterThan(0);
    expect(payload.blocks.length).toBeLessThan(50);
  });

  it('keeps every text field under Slack\'s 3000-char limit', () => {
    const longExcerpt = 'A'.repeat(5000);
    const payload = renderDigestSlack(fullData({ briefingExcerpt: longExcerpt }), HUB_URL) as {
      blocks: Array<Record<string, unknown>>;
    };

    function collectTexts(obj: unknown, out: string[]) {
      if (obj === null || obj === undefined) return;
      if (Array.isArray(obj)) {
        for (const item of obj) collectTexts(item, out);
        return;
      }
      if (typeof obj === 'object') {
        const record = obj as Record<string, unknown>;
        if (typeof record.text === 'string') out.push(record.text);
        for (const key of Object.keys(record)) collectTexts(record[key], out);
      }
    }

    const texts: string[] = [];
    collectTexts(payload.blocks, texts);
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) {
      expect(t.length).toBeLessThanOrEqual(3000);
    }
  });

  it('contains a header block and a link to the hub', () => {
    const payload = renderDigestSlack(fullData(), HUB_URL) as { blocks: Array<Record<string, unknown>> };
    const hasHeader = payload.blocks.some(b => b.type === 'header');
    expect(hasHeader).toBe(true);

    const serialized = JSON.stringify(payload);
    expect(serialized).toContain(`${HUB_URL}/pulse/code`);
  });

  it('mirrors the key numbers from the email in mrkdwn fields', () => {
    const payload = renderDigestSlack(fullData(), HUB_URL);
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain('1,234.50');
    expect(serialized).toContain('42'); // commits
  });

  it('shows em dash never $0 for null spend in Slack payload', () => {
    const data = fullData({
      code: {
        spendUsd: null,
        spendDeltaPct: null,
        spendIsPartlyEstimated: false,
        unpricedModelCount: 2,
        commits: 5,
        prs: 1,
        engagedHours: null,
        activeUsers: 2,
      },
    });
    const payload = renderDigestSlack(data, HUB_URL);
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain('—');
    expect(serialized).not.toContain('$0.00');
  });

  it('omits the Cowork section when cowork data is null', () => {
    const payload = renderDigestSlack(fullData({ cowork: null }), HUB_URL);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('Cowork');
  });

  it('escapes Slack mrkdwn control characters in the anomaly title', () => {
    const data = fullData({
      anomaly: { title: '<script>alert(1)</script> & "friends"', severity: 'high', occurredAt: WEEK_START + DAY, userLinked: false },
    });
    const payload = renderDigestSlack(data, HUB_URL);
    const serialized = JSON.stringify(payload);

    // Raw unescaped angle brackets around script must not appear.
    expect(serialized).not.toContain('<script>alert(1)</script>');
    // Slack mrkdwn escaping: & -> &amp;, < -> &lt;, > -> &gt;
    expect(serialized).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(serialized).toContain('&amp;');
  });

  it('truncates an oversized anomaly title so the section block stays under Slack\'s 3000-char limit', () => {
    const oversizedTitle = 'X'.repeat(5000);
    const data = fullData({
      anomaly: { title: oversizedTitle, severity: 'high', occurredAt: WEEK_START + DAY, userLinked: false },
    });
    const payload = renderDigestSlack(data, HUB_URL) as { blocks: Array<Record<string, unknown>> };

    const anomalyBlock = payload.blocks.find(
      b => typeof (b.text as { text?: string } | undefined)?.text === 'string'
        && (b.text as { text: string }).text.includes('Anomaly')
    );
    expect(anomalyBlock).toBeDefined();
    const text = (anomalyBlock!.text as { text: string }).text;
    expect(text.length).toBeLessThan(3000);
  });

  it('truncates an escaping-heavy oversized anomaly title so the final text stays under Slack\'s 3000-char limit', () => {
    // '&' expands to '&amp;' (5x) under escapeMrkdwn. If truncation happened
    // BEFORE escaping (slice-then-escape), 2000 chars of '&' would expand to
    // 10,000 chars post-escape — well over Slack's 3000-char hard limit.
    const escapingHeavyTitle = '&'.repeat(2000);
    const data = fullData({
      anomaly: { title: escapingHeavyTitle, severity: 'high', occurredAt: WEEK_START + DAY, userLinked: false },
    });
    const payload = renderDigestSlack(data, HUB_URL) as { blocks: Array<Record<string, unknown>> };

    const anomalyBlock = payload.blocks.find(
      b => typeof (b.text as { text?: string } | undefined)?.text === 'string'
        && (b.text as { text: string }).text.includes('Anomaly')
    );
    expect(anomalyBlock).toBeDefined();
    const text = (anomalyBlock!.text as { text: string }).text;
    expect(text.length).toBeLessThan(3000);

    // No escaped entity should be cut mid-sequence: every remaining '&'
    // must be followed by a complete 'amp;' (i.e. only whole '&amp;' tokens
    // appear, never a bare trailing '&' or partial 'amp' fragment).
    const trailingAmpersandFragment = /&(?!amp;)/;
    expect(trailingAmpersandFragment.test(text)).toBe(false);
  });

  it('omits the "Use cases needing attention" block when useCases is null', () => {
    const payload = renderDigestSlack(fullData({ useCases: null }), HUB_URL);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('Use cases needing attention');
  });

  it('includes at-risk, newly-adopted and newly-at-risk use cases when present', () => {
    const data = fullData({
      useCases: {
        atRisk: [{ title: 'Contract triage', owner: 'sam.taylor@example.com', quietWeeks: 3 }],
        newlyAdopted: ['Meeting notes summarisation'],
        newlyAtRisk: ['Invoice matching'],
      },
    });
    const payload = renderDigestSlack(data, HUB_URL);
    const serialized = JSON.stringify(payload);

    expect(serialized).toContain('Use cases needing attention');
    expect(serialized).toContain('Contract triage');
    expect(serialized).toContain('3 quiet weeks');
    expect(serialized).toContain('sam.taylor@example.com');
    expect(serialized).toContain('Meeting notes summarisation');
    expect(serialized).toContain('now adopted');
    expect(serialized).toContain('Invoice matching');
    expect(serialized).toContain('now at risk');
  });
});
