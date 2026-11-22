// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { productFactsBlock, PRODUCT_NAMING_RULE } from '@/lib/pulse/briefings/product-facts';
import { DESCRIBE_NOT_SCORE_RULE } from '@/lib/pulse/briefings/described-facts';
import { briefingCount } from '@/lib/pulse/briefings/format';

export interface DeptBriefingContext {
  dept_name: string;
  period_label: string;
  active_users: number;
  total_classified: number;
  /** Each tier by the customer's own name, with its count and share (described-facts.ts tierLines). */
  tier_lines: string[];
  /** How many of the team's sessions produced something, of those measured. */
  produced_line: string;
  confirmed_capabilities: number;
  /** Measured deep-work lines for the department — never names, summaries or file names. */
  deep_work: string[];
  /** Measured sessions and people per product (Claude Chat, Cowork, Claude in Office and Google apps, ChatGPT); empty when fewer than two were used. */
  work_by_product?: string[];
  concentration_risk_count: number;
  /** Per-product facts; empty on a Claude-only hub. */
  products?: string[];
}

export const DEPT_BRIEFING_SYSTEM = `You are an AI adoption intelligence analyst writing a monthly department briefing for a team manager.
Write in a direct, factual, and encouraging tone. Focus on progress, patterns, and actionable observations.
Do not use jargon. Do not fabricate specific names or examples.
Use only the numbers given, exactly as written. Never calculate new ones (no sums, differences or percentages of your own).
${DESCRIBE_NOT_SCORE_RULE}
${PRODUCT_NAMING_RULE}
Return a JSON object with exactly these fields:
{
  "paragraphs": [string, string, string],
  "strength": string,
  "risk_note": string,
  "recommendation": string
}
paragraphs: 3 narrative paragraphs covering (1) overall activity, how the work splits across the tiers and how many sessions produced something, and, when the data says where the work happened, one sentence on how it splits between the products listed there (Claude Chat, Cowork, the Claude in Office and Claude in Google apps, and ChatGPT), (2) the deep work the team did (the kinds of the deepest work and new ways of working given below; never name people), (3) risks or areas for focus.
strength: one short sentence about the team's biggest strength this month.
risk_note: one short sentence about the main risk or gap.
recommendation: one actionable recommendation for the manager.`;

export function buildDeptBriefingUserMessage(ctx: DeptBriefingContext): string {
  return `Generate a monthly Work Pulse briefing for the **${ctx.dept_name}** department.

Period: ${ctx.period_label}

Data:
- Active users: ${briefingCount(ctx.active_users)}
- Tasks Claude judged: ${briefingCount(ctx.total_classified)}
${ctx.tier_lines.map(l => `- ${l}`).join('\n')}
- ${ctx.produced_line}
- New ways of working confirmed: ${ctx.confirmed_capabilities}
- People who are the only one doing three or more kinds of the deepest work: ${ctx.concentration_risk_count}

${ctx.work_by_product?.length ? `${ctx.work_by_product.map(l => `- ${l}`).join('\n')}

` : ''}Deep work (measured):
${ctx.deep_work.map(l => `- ${l}`).join('\n')}
${productFactsBlock(ctx.products ?? [])}
Write the briefing now.`;
}
