// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { productFactsBlock, PRODUCT_NAMING_RULE } from '@/lib/pulse/briefings/product-facts';
import { DESCRIBE_NOT_SCORE_RULE } from '@/lib/pulse/briefings/described-facts';
import { briefingCount } from '@/lib/pulse/briefings/format';

export interface CioBriefingContext {
  period_label: string;           // e.g. "May 2026"
  weekly_active_users: number;
  total_classified_events: number;
  /** Each tier by the customer's own name, with its count and share (described-facts.ts tierLines). */
  tier_lines: string[];
  /** How many sessions produced something, of those measured (described-facts.ts producedLine). */
  produced_line: string;
  confirmed_capability_creation_count: number;
  concentration_risk_count: number;   // users who are sole runner of 3+ T3 workflows
  /** Measured organisation-wide deep-work lines — never names, summaries or file names. */
  deep_work: string[];
  /** Measured sessions and people per product (Claude Chat, Cowork, Claude in Office and Google apps, ChatGPT); empty when fewer than two were used. */
  work_by_product?: string[];
  /** Departments below the admin's floor of meaningful or frontier work (described-facts.ts). */
  floor_line: string;
  // Open department process opportunities awaiting review on the Use Cases
  // register (counts are MEASURED — the caller supplies them; the model must
  // never invent names or contents for them). Empty when the feature or its
  // content switch is off — the prompt then omits the section entirely.
  dept_process_opportunities: Array<{ department: string; count: number }>;
  /** Per-product facts (lib/pulse/briefings/product-facts.ts); empty on a Claude-only hub. */
  products?: string[];
}

export const CIO_BRIEFING_SYSTEM = `You are a trusted senior advisor writing a monthly AI Intelligence Briefing for a Chief Information Officer or executive sponsor.

Write in British English. Direct, measured prose. No marketing language. No AI-sounding phrases. Write like a management consultant who respects the reader's time.

OUTPUT FORMAT (respond with a JSON object only):
{
  "paragraphs": ["paragraph 1", "paragraph 2", "paragraph 3"],
  "named_risk": "one sentence naming the most material risk this month",
  "recommendation": "one directly actionable recommendation"
}

PARAGRAPH 1: The headline adoption picture. Active users, how the work splits across the tiers, and what it means for how the organisation uses AI. If the data says where the work happened, add one sentence on how the work splits between the products listed there (Claude Chat, Cowork, the Claude in Office apps (Excel, Word, PowerPoint, Outlook), the Claude in Google apps (Sheets, Docs, Slides) and ChatGPT), using those counts.
PARAGRAPH 2: How deep the work goes and what it produced: the share of work in the two deeper tiers, how many sessions produced something, new ways of working confirmed, and work that rests on a few people if present.
PARAGRAPH 3: What needs attention this month. Name specific teams or patterns. Be direct about gaps. If the data lists open department process opportunities, weave in at most one sentence saying how many are open and where they concentrate, and that they await review on the Use Cases register. The counts and department names are measured; never invent titles or describe their contents.
NAMED RISK: The single most material risk. Specific, not generic.
RECOMMENDATION: One action the executive can take or direct this month. Specific and directly actionable.

Tone constraints:
- Never use the word "impressive", "amazing", "fantastic", "great", "wonderful"
- Never say "it's important to" or "make sure to"
- Never use em dashes
- Use British spelling throughout
- Address the reader as "the organisation" not "your organisation"
- Use only the numbers given, exactly as written. Never calculate new ones (no sums, differences or percentages of your own)
- ${DESCRIBE_NOT_SCORE_RULE}
- ${PRODUCT_NAMING_RULE}`;

export function buildCioBriefingUserMessage(ctx: CioBriefingContext): string {
  const concentrationNote = ctx.concentration_risk_count > 0
    ? `${ctx.concentration_risk_count} ${ctx.concentration_risk_count === 1 ? 'person is' : 'people are'} the only one doing three or more kinds of the deepest work, so that work rests on them.`
    : 'No kind of the deepest work rests on one person alone.';

  return `Write the monthly AI Intelligence Briefing.

PERIOD: ${ctx.period_label}

ADOPTION
Active users this month: ${briefingCount(ctx.weekly_active_users)}
Tasks Claude judged: ${briefingCount(ctx.total_classified_events)}
${ctx.tier_lines.join('\n')}
${ctx.work_by_product?.length ? `
WHERE THE WORK HAPPENED
${ctx.work_by_product.join('\n')}
` : ''}
DEPTH AND WHAT IT PRODUCED
${ctx.produced_line}
New ways of working confirmed this month: ${ctx.confirmed_capability_creation_count}
${ctx.deep_work.join('\n')}
${productFactsBlock(ctx.products ?? [])}
WHERE ATTENTION IS NEEDED
${concentrationNote}
${ctx.floor_line}
${ctx.dept_process_opportunities.length > 0 ? `
PROCESS OPPORTUNITIES (measured counts, awaiting human review on the Use Cases register)
${ctx.dept_process_opportunities.map(d => `${d.department}: ${d.count} open`).join('\n')}
` : ''}
Write the briefing now. Return only the JSON object.`;
}
