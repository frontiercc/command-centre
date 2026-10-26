// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Weekly Exec Digest — deterministic renderers.
 *
 * Takes the plain-data snapshot from lib/digest/build.ts (DigestData) and
 * renders it two ways:
 *   - renderDigestHtml: a single self-contained HTML email (inline styles
 *     only — Gmail and most clients strip <style> blocks; table-based
 *     layout for email-client compatibility).
 *   - renderDigestSlack: an incoming-webhook `{ blocks: [...] }` payload.
 *
 * No data access, no formatting decisions deferred to callers — everything
 * needed to produce the final artefact lives here. Null discipline mirrors
 * DigestData's contract: null spend renders as an em dash plus the
 * unpriced-models caveat (never $0.00); null deltas omit the
 * arrow/comparison phrase entirely; a null surface section is omitted
 * outright, not zero-filled.
 */
import type { DigestData } from '@/lib/digest/build';
import { humanTimeSentence } from '@/lib/pulse/human-time';

const DAY = 86400;

// ---------------------------------------------------------------------------
// Shared formatting helpers
// ---------------------------------------------------------------------------

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Slack mrkdwn only requires escaping &, <, > — see
// https://api.slack.com/reference/surfaces/formatting#escaping
export function escapeMrkdwn(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatUsd(value: number | null): string {
  if (value === null) return '—';
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDeltaPhrase(pct: number | null): string {
  if (pct === null) return '';
  const arrow = pct >= 0 ? '↑' : '↓';
  const displayPct = Math.round(Math.abs(pct) * 100);
  return ` (${arrow} ${displayPct}% vs last completed week (Mon–Sun))`;
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

function formatDateRange(weekStart: number, weekEnd: number): string {
  const start = new Date(weekStart * 1000);
  const end = new Date((weekEnd - DAY) * 1000); // weekEnd is exclusive; last day is Sunday
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${fmt(start)}–${fmt(end)}`;
}

function estimateCaveatLines(code: NonNullable<DigestData['code']>): string[] {
  const lines: string[] = [];
  if (code.spendIsPartlyEstimated) {
    lines.push('includes provider-routed usage estimated at list pricing.');
  }
  if (code.unpricedModelCount > 0) {
    lines.push(`excludes ${code.unpricedModelCount} unpriced model${code.unpricedModelCount === 1 ? '' : 's'}.`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// HTML email renderer
// ---------------------------------------------------------------------------

const COLOR_HEADER_BG = '#0B1220';
const COLOR_TEXT = '#1A1A1A';
const COLOR_MUTED = '#6B7280';
const COLOR_BLUE = '#2563EB';
const COLOR_AMBER_BG = '#FFFBEB';
const COLOR_AMBER_BORDER = '#F59E0B';
const COLOR_AMBER_TEXT = '#92400E';
const COLOR_BORDER = '#E5E7EB';

function renderCodeRowHtml(code: DigestData['code']): string {
  if (!code) return '';

  const spendLine = `${formatUsd(code.spendUsd)}${formatDeltaPhrase(code.spendDeltaPct)}`;
  const engagedHoursText = code.engagedHours === null ? '—' : `${code.engagedHours.toLocaleString('en-US')} hrs`;

  return `
    <tr>
      <td style="padding:16px 24px;border-bottom:1px solid ${COLOR_BORDER};">
        <p style="margin:0 0 8px 0;font-size:14px;font-weight:bold;color:${COLOR_TEXT};">Developer Pulse</p>
        <p style="margin:0 0 4px 0;font-size:14px;color:${COLOR_TEXT};">Spend: <strong>${spendLine}</strong></p>
        <p style="margin:0 0 4px 0;font-size:14px;color:${COLOR_TEXT};">Commits: <strong>${formatNumber(code.commits)}</strong> &nbsp;|&nbsp; PRs: <strong>${formatNumber(code.prs)}</strong></p>
        <p style="margin:0 0 4px 0;font-size:14px;color:${COLOR_TEXT};">Engaged hours: <strong>${engagedHoursText}</strong></p>
        <p style="margin:0;font-size:14px;color:${COLOR_TEXT};">Active users: <strong>${formatNumber(code.activeUsers)}</strong></p>
      </td>
    </tr>`;
}

function renderCoworkRowHtml(cowork: DigestData['cowork']): string {
  if (!cowork) return '';

  return `
    <tr>
      <td style="padding:16px 24px;border-bottom:1px solid ${COLOR_BORDER};">
        <p style="margin:0 0 8px 0;font-size:14px;font-weight:bold;color:${COLOR_TEXT};">Work Pulse</p>
        <p style="margin:0 0 4px 0;font-size:14px;color:${COLOR_TEXT};">Classified work: <strong>${formatNumber(cowork.classifiedEvents)}</strong>${formatDeltaPhrase(cowork.eventsDeltaPct)}</p>
        <p style="margin:0 0 4px 0;font-size:14px;color:${COLOR_TEXT};">Tier-3 movement: <strong>${formatNumber(cowork.tier3Count)}</strong>${formatDeltaPhrase(cowork.tier3DeltaPct)}</p>
        <p style="margin:0;font-size:14px;color:${COLOR_TEXT};">Active users: <strong>${formatNumber(cowork.activeUsers)}</strong></p>
      </td>
    </tr>`;
}

function renderAnomalyHtml(anomaly: DigestData['anomaly']): string {
  if (!anomaly) return '';

  const title = escapeHtml(anomaly.title);
  const severity = escapeHtml(anomaly.severity);

  return `
    <tr>
      <td style="padding:16px 24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${COLOR_AMBER_BG};border:1px solid ${COLOR_AMBER_BORDER};border-radius:6px;">
          <tr>
            <td style="padding:12px 16px;">
              <p style="margin:0;font-size:13px;font-weight:bold;color:${COLOR_AMBER_TEXT};text-transform:uppercase;letter-spacing:0.03em;">Anomaly (${severity})</p>
              <p style="margin:4px 0 0 0;font-size:14px;color:${COLOR_AMBER_TEXT};">${title}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

function renderBriefingHtml(briefingExcerpt: string | null): string {
  if (!briefingExcerpt) return '';

  const excerpt = escapeHtml(briefingExcerpt);

  return `
    <tr>
      <td style="padding:16px 24px;border-bottom:1px solid ${COLOR_BORDER};">
        <p style="margin:0;font-size:14px;font-style:italic;color:${COLOR_MUTED};">${excerpt}</p>
      </td>
    </tr>`;
}

function renderUseCasesHtml(useCases: DigestData['useCases']): string {
  if (!useCases) return '';

  const lines: string[] = [];
  for (const u of useCases.atRisk) {
    const ownerSuffix = u.owner ? ` &middot; owner ${escapeHtml(u.owner)}` : '';
    lines.push(`&ldquo;${escapeHtml(u.title)}&rdquo; &mdash; ${u.quietWeeks} quiet week${u.quietWeeks === 1 ? '' : 's'}${ownerSuffix}`);
  }
  for (const title of useCases.newlyAdopted) {
    lines.push(`&ldquo;${escapeHtml(title)}&rdquo; is now adopted`);
  }
  for (const title of useCases.newlyAtRisk) {
    lines.push(`&ldquo;${escapeHtml(title)}&rdquo; is now at risk`);
  }

  return `
    <tr>
      <td style="padding:16px 24px;border-bottom:1px solid ${COLOR_BORDER};">
        <p style="margin:0 0 8px 0;font-size:14px;font-weight:bold;color:${COLOR_TEXT};">Use cases needing attention</p>
        ${lines.map(line => `<p style="margin:0 0 4px 0;font-size:14px;color:${COLOR_TEXT};">${line}</p>`).join('')}
      </td>
    </tr>`;
}

function renderHumanTimeHtml(h: DigestData['humanTime']): string {
  if (!h) return '';
  return `
    <tr>
      <td style="padding:16px 24px;border-bottom:1px solid ${COLOR_BORDER};">
        <p style="margin:0 0 8px 0;font-size:14px;font-weight:bold;color:${COLOR_TEXT};">By hand vs with Claude</p>
        <p style="margin:0;font-size:14px;color:${COLOR_TEXT};">${escapeHtml(humanTimeSentence(h, 'Last week'))}</p>
      </td>
    </tr>`;
}

function renderCoachingHtml(coaching: DigestData['coaching']): string {
  if (!coaching || coaching.length === 0) return '';

  const lines = coaching.map(c => {
    const noun = c.count === 1 ? 'opportunity' : 'opportunities';
    return `${escapeHtml(c.dept)}: ${formatNumber(c.count)} coaching ${noun} &mdash; open the department page in Command Centre.`;
  });

  return `
    <tr>
      <td style="padding:16px 24px;border-bottom:1px solid ${COLOR_BORDER};">
        <p style="margin:0 0 8px 0;font-size:14px;font-weight:bold;color:${COLOR_TEXT};">Coaching opportunities</p>
        ${lines.map(line => `<p style="margin:0 0 4px 0;font-size:14px;color:${COLOR_TEXT};">${line}</p>`).join('')}
      </td>
    </tr>`;
}

export function renderDigestHtml(data: DigestData, hubUrl: string): string {
  const dateRange = formatDateRange(data.weekStart, data.weekEnd);
  const hubLink = `${hubUrl}/pulse/code`;

  const caveatLines = data.code ? estimateCaveatLines(data.code) : [];
  const caveatHtml = caveatLines.length > 0
    ? `<p style="margin:8px 0 0 0;font-size:12px;color:${COLOR_MUTED};">${caveatLines.map(escapeHtml).join('<br />')}</p>`
    : '';

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F3F4F6;padding:24px 0;">
  <tr>
    <td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#FFFFFF;border-radius:8px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">
        <tr>
          <td style="background-color:${COLOR_HEADER_BG};padding:24px;">
            <p style="margin:0;font-size:12px;color:#93C5FD;text-transform:uppercase;letter-spacing:0.08em;">Frontier Command Centre</p>
            <p style="margin:4px 0 0 0;font-size:20px;font-weight:bold;color:#FFFFFF;">Your AI week &mdash; ${dateRange}</p>
          </td>
        </tr>
        ${renderCodeRowHtml(data.code)}
        ${renderCoworkRowHtml(data.cowork)}
        ${renderUseCasesHtml(data.useCases)}
        ${renderHumanTimeHtml(data.humanTime)}
        ${renderCoachingHtml(data.coaching)}
        ${renderAnomalyHtml(data.anomaly)}
        ${renderBriefingHtml(data.briefingExcerpt)}
        <tr>
          <td style="padding:20px 24px;">
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td style="background-color:${COLOR_BLUE};border-radius:6px;">
                  <a href="${hubLink}" style="display:inline-block;padding:10px 20px;font-size:14px;font-weight:bold;color:#FFFFFF;text-decoration:none;">Open Command Centre</a>
                </td>
              </tr>
            </table>
            ${caveatHtml}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
}

// ---------------------------------------------------------------------------
// Slack renderer
// ---------------------------------------------------------------------------

interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

function slackCodeFields(code: DigestData['code']): SlackBlock[] {
  if (!code) return [];

  const spendLine = `*Spend:*\n${escapeMrkdwn(formatUsd(code.spendUsd))}${escapeMrkdwn(formatDeltaPhrase(code.spendDeltaPct))}`;
  const engagedHoursText = code.engagedHours === null ? '—' : `${code.engagedHours.toLocaleString('en-US')} hrs`;

  return [
    { type: 'section', text: { type: 'mrkdwn', text: '*Developer Pulse*' } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: spendLine },
        { type: 'mrkdwn', text: `*Commits / PRs:*\n${formatNumber(code.commits)} / ${formatNumber(code.prs)}` },
        { type: 'mrkdwn', text: `*Engaged hours:*\n${engagedHoursText}` },
        { type: 'mrkdwn', text: `*Active users:*\n${formatNumber(code.activeUsers)}` },
      ],
    },
  ];
}

function slackCoworkFields(cowork: DigestData['cowork']): SlackBlock[] {
  if (!cowork) return [];

  return [
    { type: 'section', text: { type: 'mrkdwn', text: '*Work Pulse*' } },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Classified work:*\n${formatNumber(cowork.classifiedEvents)}${escapeMrkdwn(formatDeltaPhrase(cowork.eventsDeltaPct))}`,
        },
        {
          type: 'mrkdwn',
          text: `*Tier-3 movement:*\n${formatNumber(cowork.tier3Count)}${escapeMrkdwn(formatDeltaPhrase(cowork.tier3DeltaPct))}`,
        },
        { type: 'mrkdwn', text: `*Active users:*\n${formatNumber(cowork.activeUsers)}` },
      ],
    },
  ];
}

// Slack rejects section `text` fields over 3000 chars. The title is the only
// unbounded input here (severity is one of a small fixed set) — cap it well
// under the limit, mirroring the truncation already applied to the briefing
// excerpt (slackBriefingBlock, below). Escaping (escapeMrkdwn) can expand
// text up to ~5x (e.g. every char '&' -> '&amp;'), so truncation MUST happen
// AFTER escaping — slicing first and escaping second could still overflow
// Slack's 3000-char limit on the final assembled text field.
const ANOMALY_TITLE_MAX_LEN = 500;

function slackAnomalyBlock(anomaly: DigestData['anomaly']): SlackBlock[] {
  if (!anomaly) return [];

  const title = escapeMrkdwn(anomaly.title).slice(0, ANOMALY_TITLE_MAX_LEN);
  const severity = escapeMrkdwn(anomaly.severity).slice(0, ANOMALY_TITLE_MAX_LEN);

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `:warning: *Anomaly (${severity}):* ${title}` },
    },
  ];
}

function slackUseCasesBlock(useCases: DigestData['useCases']): SlackBlock[] {
  if (!useCases) return [];

  const lines: string[] = [];
  for (const u of useCases.atRisk) {
    const ownerSuffix = u.owner ? ` · owner ${escapeMrkdwn(u.owner)}` : '';
    lines.push(`"${escapeMrkdwn(u.title)}": ${u.quietWeeks} quiet week${u.quietWeeks === 1 ? '' : 's'}${ownerSuffix}`);
  }
  for (const title of useCases.newlyAdopted) {
    lines.push(`"${escapeMrkdwn(title)}" is now adopted`);
  }
  for (const title of useCases.newlyAtRisk) {
    lines.push(`"${escapeMrkdwn(title)}" is now at risk`);
  }

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Use cases needing attention*\n${lines.join('\n')}` },
    },
  ];
}

function slackHumanTimeBlock(h: DigestData['humanTime']): SlackBlock[] {
  if (!h) return [];
  return [{ type: 'section', text: { type: 'mrkdwn', text: `*By hand vs with Claude*
${escapeMrkdwn(humanTimeSentence(h, 'Last week'))}` } }];
}

function slackCoachingBlock(coaching: DigestData['coaching']): SlackBlock[] {
  if (!coaching || coaching.length === 0) return [];

  const lines = coaching.map(c => {
    const noun = c.count === 1 ? 'opportunity' : 'opportunities';
    return `${escapeMrkdwn(c.dept)}: ${formatNumber(c.count)} coaching ${noun}. Open the department page in Command Centre.`;
  });

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Coaching opportunities*\n${lines.join('\n')}` },
    },
  ];
}

function slackBriefingBlock(briefingExcerpt: string | null): SlackBlock[] {
  if (!briefingExcerpt) return [];

  const excerpt = escapeMrkdwn(briefingExcerpt).slice(0, 2900);

  return [
    { type: 'section', text: { type: 'mrkdwn', text: `_${excerpt}_` } },
  ];
}

export function renderDigestSlack(data: DigestData, hubUrl: string): object {
  const dateRange = formatDateRange(data.weekStart, data.weekEnd);
  const hubLink = `${hubUrl}/pulse/code`;

  const caveatLines = data.code ? estimateCaveatLines(data.code) : [];

  const blocks: SlackBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: `Your AI week: ${dateRange}`, emoji: true } },
    { type: 'divider' },
    ...slackCodeFields(data.code),
    ...slackCoworkFields(data.cowork),
    ...slackUseCasesBlock(data.useCases),
    ...slackHumanTimeBlock(data.humanTime),
    ...slackCoachingBlock(data.coaching),
    ...slackAnomalyBlock(data.anomaly),
    ...slackBriefingBlock(data.briefingExcerpt),
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open Command Centre', emoji: true },
          url: hubLink,
        },
      ],
    },
  ];

  if (caveatLines.length > 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: caveatLines.map(escapeMrkdwn).join(' ') }],
    });
  }

  return { blocks };
}
