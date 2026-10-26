// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Developer Pulse weekly briefing — a plain-language narrative for people who
 * never open the page. Grounded ONLY in deterministic telemetry plus the
 * (labelled) judged work mix; the prompt forbids acronyms and invented
 * numbers, mirroring the Cowork briefing language rules.
 *
 * Stored in pulse_briefings with scope_type='organisation', scope_id='code-org'
 * — reuses the existing table, never collides with Cowork briefing scopes.
 *
 * Uses getTypedClient() + schema.pulseBriefings
 * for the plain insert/select, and a local rawAll() facade for the analytic
 * reads in buildDataSummary() (aggregates/GROUP BY are clearer as raw SQL —
 * Rule 2). Every COUNT/SUM aggregate read is Number()-coerced (Policy B —
 * bigint comes back as a STRING on Postgres); `code_metrics.spend_usd` (a
 * `numeric` column on Postgres) is also Number()-coerced at the read site.
 * The "repos gone quiet" subquery needed an explicit alias on its derived
 * table (`AS quiet_repos`) — Postgres requires one.
 * The 7-day-ago date param compared against `github_repo_stats.date` is a
 * plain TEXT column (YYYY-MM-DD), so the JS-computed date string param is a
 * lexicographic comparison.
 */
import { getCodeWorkTypeLabeller } from '@/lib/pulse/code/tier-config';
import { getOrgBriefingModel } from '@/lib/anthropic/model';
import { createAnthropicClient } from '@/lib/anthropic/client';
import { and, desc, eq, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue } from '@/lib/config';
import { ORG_SCOPE_ID } from '@/lib/pulse/code/aggregator';
import { createGroundedJson, paragraphsShape, pctChange, pctOf } from '@/lib/anthropic/grounded-json';

export const CODE_BRIEFING_SCOPE_ID = 'code-org';

const SYSTEM = `You write a short weekly briefing about how an engineering organisation is using Claude Code, for a senior leader who will not open a dashboard.

Rules:
- Plain language only. Never use acronyms or metric names (no "OTI", "DDS", "autonomy ratio"; describe what the numbers mean instead).
- Use ONLY the numbers provided, exactly as written. Never invent, extrapolate, or estimate figures, and never calculate new ones (no sums, differences or percentages of your own): every change and share you may need is already given.
- Spend is context, not a verdict: interpret it alongside delegation depth and shipping.
- The work-type mix is an AI judgement. When you reference it, attribute it ("sessions Claude judged to be…"). Everything else is measured telemetry.
- Be direct about weak signals; no cheerleading.

Respond with ONLY JSON, no markdown fences:
{"paragraphs": ["...", "...", "..."], "suggestion": "one concrete, grounded action"}
Exactly 3 paragraphs: (1) cost and scale of the week, (2) how deeply work is being delegated and what kind of work it is, (3) shipping and codebase reach. The suggestion must follow from the data given.`;

export interface CodeBriefingRow {
  body: string;
  suggestion: string | null;
  model: string;
  generated_at: number;
}

// ─── Phase 3 raw-execution facade (mirrors lib/db/queries.ts's rawAll) ────────
interface RawFacade {
  execute: (q: unknown) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}
async function rawAll<T>(client: unknown, query: unknown): Promise<T[]> {
  const c = client as RawFacade;
  const res = await c.execute(query);
  return res.rows as T[];
}
async function rawGet<T>(client: unknown, query: unknown): Promise<T | undefined> {
  const rows = await rawAll<T>(client, query);
  return rows[0];
}

async function buildDataSummary(): Promise<string> {
  const client = await getTypedClient();
  const now = Math.floor(Date.now() / 1000);
  const lines: string[] = [];

  const m = await rawGet<{
    spend_usd: string | number | null;
    input_tokens: number | string;
    output_tokens: number | string;
    cache_hit_ratio: number | null;
    autonomy_ratio: number | null;
    session_count: number | string;
    repo_count: number | string;
    commit_count: number | string;
    skill_leverage: number | null;
  }>(client, sql`
    SELECT spend_usd, input_tokens, output_tokens, cache_hit_ratio, autonomy_ratio,
           session_count, repo_count, commit_count, skill_leverage
    FROM code_metrics WHERE scope_type = 'organisation' AND scope_id = ${ORG_SCOPE_ID} AND granularity = 'rolling'
    ORDER BY computed_at DESC LIMIT 1
  `);
  const prior = await rawGet<{
    spend_usd: string | number | null;
    autonomy_ratio: number | null;
    session_count: number | string;
    commit_count: number | string;
  }>(client, sql`
    SELECT spend_usd, autonomy_ratio, session_count, commit_count
    FROM code_metrics WHERE scope_type = 'organisation' AND scope_id = ${ORG_SCOPE_ID} AND granularity = 'rolling' AND computed_at <= ${now - 7 * 24 * 3600}
    ORDER BY computed_at DESC LIMIT 1
  `);

  if (!m) return '';
  const spendUsd = m.spend_usd !== null && m.spend_usd !== undefined ? Math.round(Number(m.spend_usd) * 100) / 100 : null; // pence, so the briefing never quotes $8.18486
  lines.push(`this_week: spend_usd=${spendUsd ?? 'unpriced'}, sessions=${Number(m.session_count)}, active_repos=${Number(m.repo_count)}, commits_in_claude_sessions=${Number(m.commit_count)}, tool_actions_per_human_prompt=${m.autonomy_ratio?.toFixed(2) ?? 'n/a'}, context_served_from_cache=${m.cache_hit_ratio !== null && m.cache_hit_ratio !== undefined ? Math.round(m.cache_hit_ratio * 100) + '%' : 'n/a'}`);
  if (prior) {
    const priorSpend = prior.spend_usd !== null && prior.spend_usd !== undefined ? Math.round(Number(prior.spend_usd) * 100) / 100 : null;
    lines.push(`prior_week: spend_usd=${priorSpend ?? 'unpriced'}, sessions=${Number(prior.session_count)}, commits=${Number(prior.commit_count)}, tool_actions_per_prompt=${prior.autonomy_ratio?.toFixed(2) ?? 'n/a'}`);
    // Changes worked out here, so the model never has to calculate them.
    const changes = ([
      ['spend', pctChange(spendUsd, priorSpend)],
      ['sessions', pctChange(Number(m.session_count), Number(prior.session_count))],
      ['commits', pctChange(Number(m.commit_count), Number(prior.commit_count))],
      ['tool_actions_per_prompt', pctChange(m.autonomy_ratio, prior.autonomy_ratio)],
    ] as const).filter(([, c]) => c !== null).map(([k, c]) => `${k} ${c}`);
    if (changes.length) lines.push(`change_vs_prior_week: ${changes.join(', ')}`);
  }

  // github_repo_stats.date is TEXT (YYYY-MM-DD) — a JS-computed date-string
  // param compared with >= is a lexicographic comparison.
  const overlaySince = new Date((now - 7 * 24 * 3600) * 1000).toISOString().slice(0, 10);
  const overlayTotal = await rawGet<{ c: number | string }>(client, sql`
    SELECT COALESCE(SUM(commit_count), 0) AS c FROM github_repo_stats WHERE date >= ${overlaySince}
  `);
  const overlayCount = Number(overlayTotal?.c ?? 0);
  if (overlayCount > 0) {
    const share = pctOf(Number(m.commit_count), overlayCount);
    // A share over 100% means the two counts cover different repos; say nothing rather than mislead.
    lines.push(`github_overlay: total_commits_shipped_in_mapped_repos=${overlayCount}${share !== null && share <= 100 ? `, ai_assisted_share_of_shipped_commits=${share}%` : ''}`);
  }

  if ((await getConfigValue('codeClassifierEnabled')) !== 'false') {
    const codeLabel = await getCodeWorkTypeLabeller();
    const mixRows = await rawAll<{ work_type: string; n: number | string }>(client, sql`
      SELECT csc.work_type, COUNT(*) AS n
      FROM code_session_classifications csc
      JOIN code_session_stats css ON css.session_id = csc.session_id
      WHERE csc.status = 'classified' AND css.last_at >= ${now - 7 * 24 * 3600}
      GROUP BY csc.work_type ORDER BY n DESC
    `);
    if (mixRows.length > 0) {
      const total = mixRows.reduce((sum, w) => sum + Number(w.n), 0);
      lines.push(`work_mix_ai_judged_this_week (${total} classified sessions in total, ${mixRows.length} kinds of work): ${mixRows.map(w => `"${codeLabel(w.work_type)}"=${Number(w.n)} (${pctOf(Number(w.n), total)}%)`).join(', ')}`);
    }
  }

  const darkRepos = await rawGet<{ c: number | string }>(client, sql`
    SELECT COUNT(*) AS c FROM (
      SELECT repo FROM code_session_stats WHERE repo IS NOT NULL
      GROUP BY repo HAVING MAX(last_at) < ${now - 30 * 24 * 3600}
    ) AS quiet_repos
  `);
  const darkReposCount = Number(darkRepos?.c ?? 0);
  if (darkReposCount > 0) lines.push(`repos_gone_quiet_30_days: ${darkReposCount}`);

  const friction = await rawGet<{ c: number | string }>(client, sql`
    SELECT COUNT(*) AS c FROM code_session_stats
    WHERE last_at >= ${now - 7 * 24 * 3600} AND tool_use_count >= 5
      AND CAST(error_count AS REAL) / tool_use_count > 0.25
  `);
  const frictionCount = Number(friction?.c ?? 0);
  if (frictionCount > 0) lines.push(`high_friction_sessions_this_week: ${frictionCount} (over a quarter of tool actions failed)`);

  return lines.join('\n');
}

export async function generateCodeBriefing(): Promise<CodeBriefingRow> {
  const apiKey = await getConfigValue('anthropicAiApiKey');
  if (!apiKey) throw new Error('No AI API key configured');

  const summary = await buildDataSummary();
  if (!summary) throw new Error('No Developer Pulse metrics yet. The briefing needs at least one aggregation cycle');

  const model = (await getConfigValue('codeBriefingModel')) || (await getOrgBriefingModel());
  // Every number in the reply must come from the telemetry above; one retry,
  // then GroundingRejectedError (nothing stored, so last week's briefing stays).
  const { value: parsed } = await createGroundedJson({
    client: createAnthropicClient(apiKey),
    model,
    maxTokens: 4000,
    system: SYSTEM,
    userMessage: `Write this week's Claude Code briefing from this telemetry:\n\n${summary}`,
    ...paragraphsShape(1, ['suggestion'] as const),
    cycles: 2, // a refused reply gets one fresh cycle before the job records a failure
  });

  const now = Math.floor(Date.now() / 1000);
  const body = parsed.paragraphs.join('\n\n');
  const client = await getTypedClient();
  await client.insert(schema.pulseBriefings).values({
    scope_type: 'organisation',
    scope_id: CODE_BRIEFING_SCOPE_ID,
    period_start: now - 7 * 24 * 3600,
    period_end: now,
    body,
    suggestion: parsed.suggestion ?? null,
    model,
    generated_at: now,
  });

  return { body, suggestion: parsed.suggestion ?? null, model, generated_at: now };
}

export async function getLatestCodeBriefing(): Promise<CodeBriefingRow | null> {
  const client = await getTypedClient();
  const t = schema.pulseBriefings;
  const rows = await client
    .select({ body: t.body, suggestion: t.suggestion, model: t.model, generated_at: t.generated_at })
    .from(t)
    .where(and(eq(t.scope_type, 'organisation'), eq(t.scope_id, CODE_BRIEFING_SCOPE_ID)))
    .orderBy(desc(t.generated_at))
    .limit(1);
  return rows[0] ?? null;
}
