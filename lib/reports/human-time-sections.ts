// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Report section: human time vs Claude time. Deterministic
// markdown, injected verbatim; the model never renders a figure. The by-hand
// figure is an AI ESTIMATE and is labelled in words (prose has no violet);
// Claude time is MEASURED. Organisation totals only, no person named.
import { formatHours } from '@/lib/pulse/human-time';
import { readOrgHumanTime, type OrgHumanTime } from '@/lib/pulse/human-time-summary';
import type { HumanTimeSummary, HumanTimeProductTotals } from '@/lib/pulse/human-time-summary';
import { openaiShown } from '@/lib/sources/openai-visibility';

function kindLabel(k: string): string {
  return k.replace(/_/g, ' ');
}

function row(name: string, s: HumanTimeSummary): string {
  if (s.sessions === 0) return `| ${name} | 0 | not measured | not measured |`;
  const { low, likely, high } = s.humanMinutes;
  return `| ${name} | ${s.sessions.toLocaleString('en-GB')} | about ${formatHours(likely)} (range ${formatHours(low)}–${formatHours(high)}) | ${formatHours(s.claudeMinutes)} |`;
}

/** One product's line under its surface (totals only: the summary keeps no range per product). */
function productRow(name: string, p: HumanTimeProductTotals): string {
  if (p.sessions === 0) return `| ${name} | 0 | not measured | not measured |`;
  return `| ${name} | ${p.sessions.toLocaleString('en-GB')} | about ${formatHours(p.humanMinutes)} | ${formatHours(p.claudeMinutes)} |`;
}

function kinds(name: string, s: HumanTimeSummary): string[] {
  if (!s.byKind.length) return [];
  return [
    '',
    `**${name} by kind of work** (kinds with at least five sessions):`,
    ...s.byKind.map(k => `- ${kindLabel(k.kind)}: about ${formatHours(k.humanMinutes)} hours by hand against ${formatHours(k.claudeMinutes)} hours with AI, ${k.sessions} sessions`),
  ];
}

/** Pure: the section from computed figures (null = feature off or nothing measured). */
export function renderHumanTimeSection(h: OrgHumanTime | null): string {
  const lines = ['## Human time vs AI time', ''];
  if (!h) {
    lines.push('Not measured in this period: either the feature is switched off or no Tier 2 or 3 session in the period carries both figures.');
    return lines.join('\n');
  }
  // Claude Cowork's and ChatGPT's own totals, when the summary returns them
  // (ChatGPT shown and at least one ChatGPT conversation estimated).
  const split = h.cowork.byProduct;
  const coworkCovers = split
    ? 'Cowork covers Claude Cowork and ChatGPT, each also shown on its own line'
    : 'Cowork covers Claude Cowork';
  lines.push(
    `Tier 2 and 3 sessions only. **The by-hand figures are AI estimates**, made once per session, of how long a competent person in the relevant role would take to produce the same result without AI. AI time is measured active time; on Cowork it includes the person working alongside ${split ? 'the AI' : 'Claude'}. Code covers Claude Code, and Codex where connected; ${coworkCovers}. The two are shown side by side and never combined.`,
    '',
    '| Surface | Sessions | By hand, hours (estimate) | With AI, hours (measured) |',
    '|---|---|---|---|',
    row('Code', h.code),
    row('Cowork', h.cowork),
    ...(split ? [productRow('of which Claude Cowork', split.claude), productRow('of which ChatGPT', split.openai)] : []),
    `| Total | ${h.total.sessions.toLocaleString('en-GB')} | about ${formatHours(h.total.humanMinutes)} | ${formatHours(h.total.claudeMinutes)} |`,
    ...kinds('Code', h.code),
    ...kinds('Cowork', h.cowork),
  );
  return lines.join('\n');
}

export async function buildHumanTimeSection(periodStart: string, periodEnd: string): Promise<string> {
  const startS = Math.floor(new Date(periodStart).getTime() / 1000);
  // The end date is a whole day: the window runs to the following midnight.
  const endS = Math.floor(new Date(periodEnd).getTime() / 1000) + 86400;
  // ChatGPT conversations and Codex sessions count too, unless hidden: the
  // same totals as the weekly digest.
  return renderHumanTimeSection(await readOrgHumanTime(startS, endS, { openai: await openaiShown() }));
}
