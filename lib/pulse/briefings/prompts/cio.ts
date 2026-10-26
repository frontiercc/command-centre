// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

export interface CioBriefingContext {
  period_label: string;           // e.g. "May 2026"
  weekly_active_users: number;
  total_classified_events: number;
  tier_1_pct: number;             // 0–100
  tier_2_pct: number;
  tier_3_pct: number;
  avg_dds: number | null;
  avg_oti: number | null;
  confirmed_capability_creation_count: number;
  concentration_risk_count: number;   // users who are sole runner of 3+ T3 workflows
  /** Measured organisation-wide deep-work lines — never names, summaries or file names. */
  deep_work: string[];
  teams_with_ors_below_threshold: string[];   // department names with ORS < 0.7
  departments_with_ors_count: number;         // departments with any resilience score in the period
  // Open department process opportunities awaiting review on the Use Cases
  // register (counts are MEASURED — the caller supplies them; the model must
  // never invent names or contents for them). Empty when the feature or its
  // content switch is off — the prompt then omits the section entirely.
  dept_process_opportunities: Array<{ department: string; count: number }>;
}

export const CIO_BRIEFING_SYSTEM = `You are a trusted senior advisor writing a monthly AI Intelligence Briefing for a Chief Information Officer or executive sponsor.

Write in British English. Direct, measured prose. No marketing language. No AI-sounding phrases. Write like a management consultant who respects the reader's time.

OUTPUT FORMAT (respond with a JSON object only):
{
  "paragraphs": ["paragraph 1", "paragraph 2", "paragraph 3"],
  "named_risk": "one sentence naming the most material risk this month",
  "recommendation": "one directly actionable recommendation"
}

PARAGRAPH 1: The headline adoption picture. Active users, tier distribution, and what it means for the organisation's AI maturity.
PARAGRAPH 2: The depth and resilience story. Where delegation depth is going. Capability creation events. Concentration risk if present.
PARAGRAPH 3: What needs attention this month. Name specific teams or patterns. Be direct about gaps. If the data lists open department process opportunities, weave in at most one sentence saying how many are open and where they concentrate, and that they await review on the Use Cases register. The counts and department names are measured; never invent titles or describe their contents.
NAMED RISK: The single most material risk. Specific, not generic.
RECOMMENDATION: One action the executive can take or direct this month. Specific and directly actionable.

Tone constraints:
- Never use the word "impressive", "amazing", "fantastic", "great", "wonderful"
- Never say "it's important to" or "make sure to"
- Never use em dashes
- Use British spelling throughout
- Address the reader as "the organisation" not "your organisation"
- Use only the numbers given, exactly as written. Never calculate new ones (no sums, differences or percentages of your own)`;

export function buildCioBriefingUserMessage(ctx: CioBriefingContext): string {
  const concentrationNote = ctx.concentration_risk_count > 0
    ? `${ctx.concentration_risk_count} user(s) are sole runners of 3 or more Tier 3 workflows, so concentration risk is present.`
    : 'No concentration risk detected.';

  const orsNote = ctx.teams_with_ors_below_threshold.length > 0
    ? `Departments with a resilience score below 0.7, ${ctx.teams_with_ors_below_threshold.length} in total: ${ctx.teams_with_ors_below_threshold.join(', ')}.`
    : ctx.departments_with_ors_count === 0
      ? 'No department has a resilience score yet.'
      : 'No department with a resilience score is below 0.7.';

  return `Write the monthly AI Intelligence Briefing.

PERIOD: ${ctx.period_label}

ADOPTION
Active users this month: ${ctx.weekly_active_users}
Total classified events: ${ctx.total_classified_events}
Tier 1 (single-step): ${ctx.tier_1_pct}%
Tier 2 (multi-step, moderate): ${ctx.tier_2_pct}%
Tier 3 (autonomous, high consequence): ${ctx.tier_3_pct}%

DEPTH AND CAPABILITY
Average Delegation Depth Score: ${ctx.avg_dds !== null ? ctx.avg_dds.toFixed(2) : 'no data'}
Average Output Throughput Index: ${ctx.avg_oti !== null ? `${ctx.avg_oti.toFixed(2)}x` : 'no data'}
Confirmed capability creation events this month: ${ctx.confirmed_capability_creation_count}
${ctx.deep_work.join('\n')}

RESILIENCE
${concentrationNote}
${orsNote}
${ctx.dept_process_opportunities.length > 0 ? `
PROCESS OPPORTUNITIES (measured counts, awaiting human review on the Use Cases register)
${ctx.dept_process_opportunities.map(d => `${d.department}: ${d.count} open`).join('\n')}
` : ''}
Write the briefing now. Return only the JSON object.`;
}
