// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Report section: human time vs Claude time. Deterministic
// markdown, injected verbatim; the model never renders a figure. The by-hand
// figure is an AI ESTIMATE and is labelled in words (prose has no violet);
// Claude time is MEASURED. Organisation totals only, no person named.
import { formatHours } from '@/lib/pulse/human-time';
import { readOrgHumanTime, type OrgHumanTime } from '@/lib/pulse/human-time-summary';
import type { HumanTimeSummary } from '@/lib/pulse/human-time-summary';

function kindLabel(k: string): string {
  return k.replace(/_/g, ' ');
}

function row(name: string, s: HumanTimeSummary): string {
  if (s.sessions === 0) return `| ${name} | 0 | not measured | not measured |`;
  const { low, likely, high } = s.humanMinutes;
  return `| ${name} | ${s.sessions.toLocaleString('en-GB')} | about ${formatHours(likely)} (range ${formatHours(low)}–${formatHours(high)}) | ${formatHours(s.claudeMinutes)} |`;
}

function kinds(name: string, s: HumanTimeSummary): string[] {
  if (!s.byKind.length) return [];
  return [
    '',
    `**${name} by kind of work** (kinds with at least five sessions):`,
    ...s.byKind.map(k => `- ${kindLabel(k.kind)}: about ${formatHours(k.humanMinutes)} hours by hand against ${formatHours(k.claudeMinutes)} hours with Claude, ${k.sessions} sessions`),
  ];
}

/** Pure: the section from computed figures (null = feature off or nothing measured). */
export function renderHumanTimeSection(h: OrgHumanTime | null): string {
  const lines = ['## Human time vs Claude time', ''];
  if (!h) {
    lines.push('Not measured in this period: either the feature is switched off or no Tier 2 or 3 session in the period carries both figures.');
    return lines.join('\n');
  }
  lines.push(
    'Tier 2 and 3 sessions only. **The by-hand figures are AI estimates**, made once per session, of how long a competent person in the relevant role would take to produce the same result without AI. Claude time is measured active time; on Cowork it includes the person working alongside Claude. The two are shown side by side and never combined.',
    '',
    '| Surface | Sessions | By hand, hours (estimate) | With Claude, hours (measured) |',
    '|---|---|---|---|',
    row('Code', h.code),
    row('Cowork', h.cowork),
    `| Total | ${h.total.sessions.toLocaleString('en-GB')} | about ${formatHours(h.total.humanMinutes)} | ${formatHours(h.total.claudeMinutes)} |`,
    ...kinds('Code', h.code),
    ...kinds('Cowork', h.cowork),
  );
  return lines.join('\n');
}

export async function buildHumanTimeSection(periodStart: string, periodEnd: string): Promise<string> {
  const startS = Math.floor(new Date(periodStart).getTime() / 1000);
  const endS = Math.floor(new Date(periodEnd).getTime() / 1000);
  return renderHumanTimeSection(await readOrgHumanTime(startS, endS));
}
