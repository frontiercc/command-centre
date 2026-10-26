// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

export interface DeptBriefingContext {
  dept_name: string;
  period_label: string;
  active_users: number;
  total_classified: number;
  tier_1_pct: number;
  tier_2_pct: number;
  tier_3_pct: number;
  avg_dds: number | null;
  avg_oti: number | null;
  confirmed_capabilities: number;
  /** Measured deep-work lines for the department — never names, summaries or file names. */
  deep_work: string[];
  concentration_risk_count: number;
}

export const DEPT_BRIEFING_SYSTEM = `You are an AI adoption intelligence analyst writing a monthly department briefing for a team manager.
Write in a direct, factual, and encouraging tone. Focus on progress, patterns, and actionable observations.
Do not use jargon. Do not fabricate specific names or examples.
Use only the numbers given, exactly as written. Never calculate new ones (no sums, differences or percentages of your own).
Return a JSON object with exactly these fields:
{
  "paragraphs": [string, string, string],
  "strength": string,
  "risk_note": string,
  "recommendation": string
}
paragraphs: 3 narrative paragraphs covering (1) overall activity and tier distribution, (2) the deep work the team did (the kinds of Tier 3 work and new capabilities given below; never name people), (3) risks or areas for focus.
strength: one short sentence about the team's biggest strength this month.
risk_note: one short sentence about the main risk or gap.
recommendation: one actionable recommendation for the manager.`;

export function buildDeptBriefingUserMessage(ctx: DeptBriefingContext): string {
  return `Generate a monthly Work Pulse briefing for the **${ctx.dept_name}** department.

Period: ${ctx.period_label}

Data:
- Active users: ${ctx.active_users}
- Total classified events: ${ctx.total_classified}
- Tier distribution: ${ctx.tier_1_pct}% Tier 1 (routine), ${ctx.tier_2_pct}% Tier 2 (skilled), ${ctx.tier_3_pct}% Tier 3 (advanced)
- Avg DDS (delegation depth score): ${ctx.avg_dds ?? 'no data'}
- Avg OTI (output transformation index): ${ctx.avg_oti ?? 'no data'}
- Confirmed capability creations: ${ctx.confirmed_capabilities}
- Users with concentration risk: ${ctx.concentration_risk_count}

Deep work (measured):
${ctx.deep_work.map(l => `- ${l}`).join('\n')}

Write the briefing now.`;
}
