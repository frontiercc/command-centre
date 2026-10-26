// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Block Kit renderer for a single high-priority alert pushed to Slack
 * (lib/alerts/notify-slack.ts). Pure — no DB/config/IO. Mirrors the
 * Weekly Digest's renderDigestSlack (lib/digest/render.ts) in style:
 * plain object output, mrkdwn-escaped text, truncated to stay under
 * Slack's header (140-char) and section (500-char) limits set below
 * (truncation happens AFTER escaping, since escaping can expand text —
 * same rule as the digest's ANOMALY_TITLE_MAX_LEN). The header's
 * plain_text field — and the top-level `text` fallback, which follows
 * the same plain_text rule — is never escaped; only mrkdwn blocks are.
 */
import type { Alert } from '@/lib/db/queries';
import { escapeMrkdwn } from '@/lib/digest/render';
import { categoryForType, CATEGORY_LABELS } from '@/lib/alerts/categories';

const SEVERITY_EMOJI: Record<string, string> = { critical: '🔴', high: '🟠' };
// Slack limits per block type: header plain_text max 150 chars, section mrkdwn max 3000 chars.
// Leave headroom for emoji + space prefix in header.
const HEADER_TEXT_MAX_LEN = 140;
const SECTION_TEXT_MAX_LEN = 500;

// escapeMrkdwn only ever produces the entities &amp;, &lt;, &gt; (longest is
// '&amp;', 5 chars). A naive slice-then-ellipsis can land inside one of
// these, leaving a broken fragment like '...&am…' right before the ellipsis.
// Trim back to before an unterminated trailing '&' so the ellipsis always
// follows a clean boundary — checking the last few characters for a '&' with
// no ';' after it is sufficient given this fixed, short entity set.
function trimTrailingPartialEntity(text: string): string {
  const tailStart = Math.max(0, text.length - 6);
  const tail = text.slice(tailStart);
  const ampIndex = tail.lastIndexOf('&');
  if (ampIndex === -1) return text;
  if (tail.slice(ampIndex).includes(';')) return text; // complete entity — nothing to trim
  return text.slice(0, tailStart + ampIndex);
}

function formatTimestamp(generatedAt: number): string {
  return new Date(generatedAt * 1000).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
  });
}

export function renderAlertSlack(alert: Alert, hubUrl: string): object {
  const emoji = SEVERITY_EMOJI[alert.severity] ?? '⚪';
  const title = alert.title.slice(0, HEADER_TEXT_MAX_LEN);
  const headerText = `${emoji} ${title}`;

  const escapedExplanation = escapeMrkdwn(alert.explanation);
  const explanation = escapedExplanation.length > SECTION_TEXT_MAX_LEN
    ? `${trimTrailingPartialEntity(escapedExplanation.slice(0, SECTION_TEXT_MAX_LEN))}…`
    : escapedExplanation;

  const category = CATEGORY_LABELS[categoryForType(alert.alert_type)];

  return {
    // Slack shows this in mobile/desktop push-notification previews when
    // `blocks` alone would render a blank/generic preview. Same string as
    // the header, unescaped — a plain_text preview field follows the same
    // plain_text rule as the header block.
    text: headerText,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: headerText, emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: explanation } },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `*${escapeMrkdwn(alert.alert_type)}* · ${escapeMrkdwn(category)} · ${formatTimestamp(alert.generated_at)}`,
        }],
      },
      { type: 'divider' },
      {
        type: 'actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: 'View in Command Centre', emoji: true },
          url: `${hubUrl}/alerts`,
        }],
      },
    ],
  };
}
