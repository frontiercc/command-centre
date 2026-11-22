// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { productFactsBlock, PRODUCT_NAMING_RULE } from '@/lib/pulse/briefings/product-facts';
import { DESCRIBE_NOT_SCORE_RULE } from '@/lib/pulse/briefings/described-facts';
import { briefingCount } from '@/lib/pulse/briefings/format';

export interface WeeklyBriefingContext {
  user_id: string;
  display_name: string | null;
  period_start_label: string; // e.g. "25 May 2026"
  period_end_label: string;   // e.g. "31 May 2026"
  tier_1_count: number;
  tier_2_count: number;
  tier_3_count: number;
  /** Each tier by the customer's own name, with its count and share (described-facts.ts tierLines). */
  tier_lines: string[];
  /** How many of the person's sessions produced something, of those measured. */
  produced_line: string;
  /** Measured deep-work lines (best work, mainstay, capabilities) — never names, summaries or file names. */
  deep_work: string[];
  task_types_used: string[];      // distinct task_types classified this week
  /** Per-product facts for this person; empty when they used no ChatGPT this week. */
  products?: string[];
}

export const WEEKLY_BRIEFING_SYSTEM = `You are a trusted advisor writing a personal weekly briefing for a professional who uses AI in their daily work.

Write in British English. Use plain, direct prose. No marketing language. No AI-sounding phrases. No superlatives. Write as an experienced operator would talk to a colleague: honest, specific, occasionally dry.

OUTPUT FORMAT (respond with a JSON object only):
{
  "paragraphs": ["paragraph 1", "paragraph 2", "paragraph 3"],
  "suggestion": "one sentence suggestion for next week"
}

PARAGRAPH 1: What happened this week. State the numbers matter-of-factly, using only the numbers given, exactly as written: never calculate new ones (no sums, differences or percentages of your own). Mention specific task types if they are interesting. Do not pad.
PARAGRAPH 2: What the pattern means. If there was deep work or a new way of working, name the kind of work and what it involved, using only the facts given. If the numbers are flat, say so without apology. Be honest about weak weeks.
PARAGRAPH 3: How this fits the longer arc. Keep it brief. Do not project too far forward.

Tone constraints:
- Never use the word "impressive", "amazing", "fantastic", "great", "wonderful"
- Never say "it's important to" or "make sure to"
- Never use em dashes
- Use British spelling throughout
- Claude judges the tasks, never the person: say what kind of work a task was, never what the person is like or how good they are
- ${DESCRIBE_NOT_SCORE_RULE}
- ${PRODUCT_NAMING_RULE}

SUGGESTION: One concrete, specific action grounded in the actual data above. It must reference something specific from this week (a particular task type, what the sessions produced, or a piece of deep work). Never suggest running the same task N times. Never suggest "documenting" something unless there is a clear reason. If the week was uneventful, suggest trying a specific task type from the list that the person hasn't done in a while. Keep it to one sentence.`;

function formatTaskType(slug: string): string {
  return slug.replace(/:/g, ' · ').replace(/_/g, ' ');
}

export function buildWeeklyBriefingUserMessage(ctx: WeeklyBriefingContext): string {
  const name = ctx.display_name ?? 'this person';
  const totalTasks = ctx.tier_1_count + ctx.tier_2_count + ctx.tier_3_count;
  const deepWork = ctx.deep_work.length > 0 ? ctx.deep_work.join('\n') : 'None of the deepest work this week.';

  return `Write the weekly briefing for ${name}.

PERIOD: ${ctx.period_start_label} to ${ctx.period_end_label}

ACTIVITY THIS WEEK
Tasks Claude judged: ${briefingCount(totalTasks)}
${ctx.tier_lines.join('\n')}
${ctx.produced_line}

Task types used this week: ${ctx.task_types_used.length > 0 ? `${ctx.task_types_used.length} in total: ${ctx.task_types_used.map(formatTaskType).join(', ')}` : 'none recorded'}

DEEP WORK (measured)
${deepWork}
${productFactsBlock(ctx.products ?? [])}
Write the briefing now. Return only the JSON object.`;
}
