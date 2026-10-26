// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { renderAlertSlack } from '@/lib/alerts/render-slack';
import type { Alert } from '@/lib/db/queries';

const HUB_URL = 'https://ccc.example.com';

function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: 'a1',
    user_id: 'sam.taylor',
    alert_type: 'code_cost_spike',
    severity: 'high',
    title: 'Claude Code spend spike: $30.00 in 24h',
    explanation: 'sam.taylor spent $30.00 on Claude Code in the last 24 hours — trailing daily average is $9.00 (threshold $25.00).',
    raw_evidence: null,
    status: 'open',
    generated_at: Date.UTC(2026, 6, 28, 14, 30) / 1000,
    resolved_at: null,
    resolved_by: null,
    ...overrides,
  };
}

type SlackBlock = { type: string; text?: { text: string }; elements?: Array<{ url?: string; text?: string }> };
type SlackPayload = { text: string; blocks: SlackBlock[] };

describe('renderAlertSlack', () => {
  it('includes a top-level text field matching the header, for push-notification previews', () => {
    const payload = renderAlertSlack(makeAlert({ severity: 'critical', title: 'Data exfiltration pattern detected' }), HUB_URL) as SlackPayload;
    expect(payload.text).toBe(payload.blocks[0].text!.text);
    expect(payload.text).toContain('🔴');
    expect(payload.text).toContain('Data exfiltration pattern detected');
  });

  it('appends an ellipsis to the explanation when it was actually truncated', () => {
    const longText = 'x'.repeat(5000);
    const payload = renderAlertSlack(makeAlert({ explanation: longText }), HUB_URL) as { blocks: SlackBlock[] };
    const sectionText = payload.blocks[1].text!.text;
    expect(sectionText.endsWith('…')).toBe(true);
  });

  it('does not append an ellipsis when the explanation is short (no truncation occurred)', () => {
    const payload = renderAlertSlack(makeAlert({ explanation: 'short explanation, well under the limit' }), HUB_URL) as { blocks: SlackBlock[] };
    const sectionText = payload.blocks[1].text!.text;
    expect(sectionText.endsWith('…')).toBe(false);
    expect(sectionText).toBe('short explanation, well under the limit');
  });

  it('renders a critical alert with the red emoji and title in the header', () => {
    const payload = renderAlertSlack(makeAlert({ severity: 'critical', title: 'Data exfiltration pattern detected' }), HUB_URL) as { blocks: SlackBlock[] };
    expect(payload.blocks[0].type).toBe('header');
    expect(payload.blocks[0].text!.text).toContain('🔴');
    expect(payload.blocks[0].text!.text).toContain('Data exfiltration pattern detected');
  });

  it('renders a high alert with the orange emoji', () => {
    const payload = renderAlertSlack(makeAlert(), HUB_URL) as { blocks: SlackBlock[] };
    expect(payload.blocks[0].text!.text).toContain('🟠');
  });

  it('includes the explanation and links to /alerts', () => {
    const payload = renderAlertSlack(makeAlert(), HUB_URL) as { blocks: SlackBlock[] };
    const section = payload.blocks[1];
    expect(section.text!.text).toContain('sam.taylor spent $30.00');
    const actions = payload.blocks.find(b => b.type === 'actions')!;
    expect(actions.elements![0].url).toBe(`${HUB_URL}/alerts`);
  });

  it('includes the alert type and category in the context line', () => {
    const payload = renderAlertSlack(makeAlert(), HUB_URL) as { blocks: SlackBlock[] };
    const context = payload.blocks.find(b => b.type === 'context')!;
    expect(context.elements![0].text).toContain('code_cost_spike');
    // Category is escaped, so '&' becomes '&amp;'
    expect(context.elements![0].text).toContain('Cost &amp; Efficiency');
  });

  it('escapes mrkdwn special characters in explanation but not in header (plain_text)', () => {
    const payload = renderAlertSlack(makeAlert({ title: 'A & B < C', explanation: 'x > y & z' }), HUB_URL) as { blocks: SlackBlock[] };
    // Header is plain_text — never escaped
    expect(payload.blocks[0].text!.text).toContain('A & B < C');
    // Explanation is mrkdwn — must be escaped
    expect(payload.blocks[1].text!.text).toBe('x &gt; y &amp; z');
  });

  it('truncates a very long title/explanation to stay under Slack limits', () => {
    const longText = 'x'.repeat(5000);
    const payload = renderAlertSlack(makeAlert({ title: longText, explanation: longText }), HUB_URL) as { blocks: SlackBlock[] };
    // Header includes emoji + space, so final length should be <= 150 (Slack's header plain_text limit)
    expect(payload.blocks[0].text!.text.length).toBeLessThanOrEqual(150);
    expect(payload.blocks[1].text!.text.length).toBeLessThan(600);
  });

  it('escapes before truncating (for mrkdwn blocks), so escape-expanding characters do not overflow limits', () => {
    // Each '&' expands to '&amp;' (5x) when escaped. Build a long string of ampersands
    // to ensure that if truncation happened before escaping, the escaped output would
    // be far longer than SECTION_TEXT_MAX_LEN (500): every truncated raw '&' still
    // expands to a full 5-char '&amp;' after escaping, so slice-then-escape produces
    // 500*5=2500 chars, not the 500 chars produced by the correct escape-then-slice.
    const longAmpersands = '&'.repeat(600);
    const payload = renderAlertSlack(makeAlert({ title: longAmpersands, explanation: longAmpersands }), HUB_URL) as { blocks: SlackBlock[] };
    const headerText = (payload.blocks[0] as { text: { text: string } }).text.text;
    const sectionText = (payload.blocks[1] as { text: { text: string } }).text.text;

    // Header is plain_text and is NOT escaped, so it's just truncated raw ampersands
    expect(headerText.length).toBeLessThanOrEqual(150);

    // Explanation was long enough to be truncated, so an ellipsis was appended —
    // strip it before checking the escaped-and-sliced body itself.
    expect(sectionText.endsWith('…')).toBe(true);
    const body = sectionText.slice(0, -1);

    // Escape-then-slice (correct order) produces EXACTLY SECTION_TEXT_MAX_LEN (500)
    // chars, all of them complete '&amp;' units (500 / '&amp;'.length = 100 — no
    // partial fragment). Slice-then-escape (a reintroduced ordering bug) would
    // instead escape 500 raw '&' characters into 2500 chars — unlike the dead
    // `includes('&am')` check this replaces (vacuous: '&amp;' always contains '&am'
    // as a prefix, so the check could never fail under either ordering), this exact
    // length comparison genuinely fails if the bug is reintroduced.
    expect(body.length).toBe(500);
    expect(body.endsWith('&amp;')).toBe(true);
  });

  it('trims back past a partial mrkdwn entity instead of leaving a broken fragment before the ellipsis', () => {
    // 497 'a's followed by a raw '&' pushes the escaped '&amp;' (5 chars) to
    // span indices 497-501 of the escaped string. SECTION_TEXT_MAX_LEN (500)
    // cuts at index 500 — landing inside the entity ('...a&am') before the
    // trim fix is applied.
    const explanation = 'a'.repeat(497) + '&' + 'x'.repeat(50);
    const payload = renderAlertSlack(makeAlert({ explanation }), HUB_URL) as { blocks: SlackBlock[] };
    const sectionText = payload.blocks[1].text!.text;

    expect(sectionText.endsWith('…')).toBe(true);
    // No truncated entity fragment: a bare '&' must never appear immediately
    // before the trailing ellipsis (allowing for a short run of entity-name
    // characters like 'am' or 'amp' that a partial cut could leave behind).
    expect(sectionText).not.toMatch(/&[a-z]{0,4}…$/);
    expect(sectionText).toBe(`${'a'.repeat(497)}…`);
  });
});
