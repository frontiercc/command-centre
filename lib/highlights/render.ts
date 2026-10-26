// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Weekly Highlights — pure post assembly. Every figure comes from the measured
 * HighlightsInput; the composed prose supplies ONLY the deliverable sentences
 * and the subject phrase. Testable against fixtures with no DB and no model.
 * No asterisks — Slack renders them literally depending on the poster.
 *
 * codeOutput.basis honesty: the code-output figures are either genuinely
 * this-week's (basis='week', from a weekly code_metrics row) or a fallback
 * rolling snapshot (basis='rolling', a running total, not week-scoped — see
 * gather.ts). A rolling figure must never be presented as "this week"'s, so
 * the rolling line works "over the last 30 days" into the same sentence
 * instead of silently reusing the week-scoped wording.
 */
import type { HighlightsInput } from '@/lib/highlights/gather';
import type { ComposedHighlights } from '@/lib/highlights/compose';
import { formatHours } from '@/lib/pulse/human-time';

const fmt = (n: number) => n.toLocaleString('en-GB');

export function renderHighlightsPost(input: HighlightsInput, composed: ComposedHighlights): string {
  const lines: string[] = [];

  lines.push(':rocket: What a week of Claude actually produced :bar_chart:');
  lines.push('');
  lines.push(
    'This week produced work we would normally scope, staff and plan for. '
    + composed.deliverables.map(d => d.sentence).join(' ')
    + ' Seven days. None of it existed last week. :fire:'
  );
  lines.push('');
  lines.push(`${fmt(input.headcount)} of our people used Claude this week. Here is what that looked like:`);
  lines.push('');
  lines.push(`:briefcase: The team put Claude on ${composed.subject}`);

  if (input.engineeringMix.length > 0) {
    const total = input.engineeringMix.reduce((s, m) => s + m.sessions, 0);
    const breakdown = input.engineeringMix.map(m => `${m.workType.replace(/_/g, ' ')} (${fmt(m.sessions)})`).join('; ');
    lines.push(`:mag: Engineering: ${fmt(total)} sessions: ${breakdown}`);
  }

  if (input.systems.totalCalls > 0) {
    const top = input.systems.top.slice(0, 4).map(t => t.server).join(', ');
    lines.push(`:electric_plug: Claude worked inside our own systems ${fmt(input.systems.totalCalls)} times, across ${fmt(input.systems.distinctSystems)} different systems, led by ${top}`);
  }

  if (input.codeOutput) {
    const c = input.codeOutput;
    const prefix = c.basis === 'rolling' ? 'Over the last 30 days, ' : '';
    lines.push(`:computer: ${prefix}${fmt(c.linesChanged)} lines of code changed from ${fmt(c.handsOnHours)} hours at the keyboard, and ${fmt(c.changesKept)} of the ${fmt(c.changesProposed)} changes Claude proposed were kept`);
  }

  if (input.humanTime) {
    const h = input.humanTime;
    lines.push(`:hourglass_flowing_sand: About ${formatHours(h.humanMinutes)} hours of work by hand (AI estimate), done in ${formatHours(h.claudeMinutes)} hours with Claude, across ${fmt(h.sessions)} sessions`);
  }

  if (input.tier3Count > 0) {
    lines.push(`:dart: ${fmt(input.tier3Count)} pieces of work where Claude ran the whole process across several systems, with the person just setting the parameters`);
  }

  if (input.shoutouts && (input.shoutouts.systems || input.shoutouts.skills)) {
    const parts: string[] = [];
    const sys = input.shoutouts.systems;
    const sk = input.shoutouts.skills;
    if (sys) parts.push(`@${sys.person}, who put Claude into ${fmt(sys.distinct)} different systems ${fmt(sys.count)} times`);
    if (sk) parts.push(`@${sk.person}, who used ${fmt(sk.distinct)} different Claude skills`);
    lines.push('');
    lines.push(`Special mention to ${parts.join(', and ')}. :clap:`);
  }

  return lines.join('\n');
}
