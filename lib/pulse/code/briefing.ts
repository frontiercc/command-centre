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
 * The 7-day window's first date compared against `github_repo_stats.date` is
 * a plain TEXT column (YYYY-MM-DD), so the JS-computed date string param is a
 * lexicographic comparison.
 */
import { getCodeWorkTypeLabeller } from '@/lib/pulse/code/tier-config';
import { visibleOpenAi } from '@/lib/sources/openai-visibility';
import { getOrgBriefingModel } from '@/lib/anthropic/model';
import { createAnthropicClient } from '@/lib/anthropic/client';
import { and, desc, eq, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue } from '@/lib/config';
import { ORG_SCOPE_ID } from '@/lib/pulse/code/aggregator';
import { createGroundedJson, paragraphsShape, pctChange, pctOf } from '@/lib/anthropic/grounded-json';
import { hasCodexData, pickCodeMetricsSource } from '@/lib/pulse/code/vendor-view';
import { buildDailyWindow } from '@/lib/pulse/code/shipping-alignment';

export const CODE_BRIEFING_SCOPE_ID = 'code-org';

const SYSTEM_BASE = `You write a short weekly briefing about how an engineering organisation is using Claude Code, for a senior leader who will not open a dashboard.

Rules:
- Plain language only. Never use acronyms or metric names (no "OTI", "DDS", "autonomy ratio"; describe what the numbers mean instead).
- Use ONLY the numbers provided, exactly as written. Never invent, extrapolate, or estimate figures, and never calculate new ones (no sums, differences or percentages of your own): every change and share you may need is already given.
- Spend is context, not a verdict: interpret it alongside how much AI does for each prompt and what ships.
- Say tool actions per prompt as what it is, for example "AI took about 4.7 actions for each prompt". Never call it delegation depth, a depth, a score, an index or a ratio.
- The work-type mix is an AI judgement. When you reference it, attribute it ("sessions Claude judged to be…"). Everything else is measured telemetry.
- Be direct about weak signals; no cheerleading.
- Write money with a thousands comma and two decimals, for example $4,353.60. Write counts with a thousands comma, for example 1,354.
- Write in full sentences. Never use a colon to join two clauses or to set off an aside.

Respond with ONLY JSON, no markdown fences:
{"paragraphs": ["...", "...", "..."], "suggestion": "one concrete, grounded action"}
Exactly 3 paragraphs: (1) cost and scale of the week, (2) how much of the work AI carries out for each prompt and what kind of work it is, (3) shipping and codebase reach. The suggestion must follow from the data given.`;

/** Once Codex data exists the briefing covers both coding tools and names each. */
const PRODUCT_RULE = `
- The organisation uses two coding tools: Claude Code and Codex (OpenAI). The PRODUCTS lines give each one's own figures. Name the tool whenever you quote a figure for one of them, never describe Codex activity as Claude Code, and do not recommend one vendor over the other unless the figures given support it.`;

function systemPrompt(codexPresent: boolean): string {
  if (!codexPresent) return SYSTEM_BASE;
  return SYSTEM_BASE
    .replace('is using Claude Code,', 'is using Claude Code and Codex,')
    .replace('- Be direct about weak signals; no cheerleading.', `- Be direct about weak signals; no cheerleading.${PRODUCT_RULE}`);
}

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

async function buildDataSummary(codexPresent: boolean): Promise<string> {
  const client = await getTypedClient();
  const now = Math.floor(Date.now() / 1000);
  const lines: string[] = [];
  // All products once Codex data exists (lib/pulse/code/vendor-view.ts). A weekly briefing, so it
  // reads the aggregator's 7-day rows ('rolling_7d'), not Developer Pulse's 30-day headline rows.
  const src = await pickCodeMetricsSource('all', codexPresent);

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
    FROM ${src.table} WHERE scope_type = 'organisation' AND scope_id = ${ORG_SCOPE_ID} AND granularity = 'rolling_7d' ${src.only}
    ORDER BY computed_at DESC LIMIT 1
  `);
  const prior = await rawGet<{
    spend_usd: string | number | null;
    autonomy_ratio: number | null;
    session_count: number | string;
    commit_count: number | string;
  }>(client, sql`
    SELECT spend_usd, autonomy_ratio, session_count, commit_count
    FROM ${src.table} WHERE scope_type = 'organisation' AND scope_id = ${ORG_SCOPE_ID} AND granularity = 'rolling_7d' AND computed_at <= ${now - 7 * 24 * 3600} ${src.only}
    ORDER BY computed_at DESC LIMIT 1
  `);

  if (!m) return '';
  const spendUsd = m.spend_usd !== null && m.spend_usd !== undefined ? Math.round(Number(m.spend_usd) * 100) / 100 : null; // pence, so the briefing never quotes $8.18486
  lines.push(`this_week: spend_usd=${spendUsd ?? 'unpriced'}, sessions=${Number(m.session_count)}, ${Number(m.repo_count) > 0 ? `active_repos=${Number(m.repo_count)}, ` : ''}${codexPresent ? 'commits_in_ai_coding_sessions' : 'commits_in_claude_sessions'}=${Number(m.commit_count)}, tool_actions_per_human_prompt=${m.autonomy_ratio?.toFixed(1) ?? 'n/a'}, context_served_from_cache=${m.cache_hit_ratio !== null && m.cache_hit_ratio !== undefined ? Math.round(m.cache_hit_ratio * 100) + '%' : 'n/a'}`);
  if (prior) {
    const priorSpend = prior.spend_usd !== null && prior.spend_usd !== undefined ? Math.round(Number(prior.spend_usd) * 100) / 100 : null;
    lines.push(`prior_week: spend_usd=${priorSpend ?? 'unpriced'}, sessions=${Number(prior.session_count)}, commits=${Number(prior.commit_count)}, tool_actions_per_prompt=${prior.autonomy_ratio?.toFixed(1) ?? 'n/a'}`);
    // Changes worked out here, so the model never has to calculate them.
    const changes = ([
      ['spend', pctChange(spendUsd, priorSpend)],
      ['sessions', pctChange(Number(m.session_count), Number(prior.session_count))],
      ['commits', pctChange(Number(m.commit_count), Number(prior.commit_count))],
      ['tool_actions_per_prompt', pctChange(m.autonomy_ratio, prior.autonomy_ratio)],
    ] as const).filter(([, c]) => c !== null).map(([k, c]) => `${k} ${c}`);
    if (changes.length) lines.push(`change_vs_prior_week: ${changes.join(', ')}`);
  }

  // Each coding tool's own figures, worked out here so the model never calculates them.
  if (codexPresent) {
    const product = async (vendor: 'claude' | 'openai') => {
      const { table, only } = await pickCodeMetricsSource(vendor, true);
      return rawGet<{
        spend_usd: string | number | null; session_count: number | string; commit_count: number | string; autonomy_ratio: number | null;
      }>(client, sql`
        SELECT spend_usd, session_count, commit_count, autonomy_ratio
        FROM ${table} WHERE scope_type = 'organisation' AND scope_id = ${ORG_SCOPE_ID} AND granularity = 'rolling_7d' ${only}
        ORDER BY computed_at DESC LIMIT 1
      `);
    };
    const totalSpend = spendUsd;
    const totalSessions = Number(m.session_count);
    lines.push('PRODUCTS (this week, each tool on its own)');
    for (const [name, vendor] of [['Claude Code', 'claude'], ['Codex', 'openai']] as const) {
      const p = await product(vendor);
      if (!p) { lines.push(`${name}: no activity this week`); continue; }
      const spend = p.spend_usd !== null && p.spend_usd !== undefined ? Math.round(Number(p.spend_usd) * 100) / 100 : null;
      const sessionShare = pctOf(Number(p.session_count), totalSessions);
      const spendShare = spend !== null && totalSpend !== null ? pctOf(spend, totalSpend) : null;
      lines.push(`${name}: spend_usd=${spend ?? 'unpriced'}${spendShare !== null ? ` (${spendShare}% of spend)` : ''}, sessions=${Number(p.session_count)}${sessionShare !== null ? ` (${sessionShare}% of sessions)` : ''}, commits=${Number(p.commit_count)}, tool_actions_per_human_prompt=${p.autonomy_ratio?.toFixed(1) ?? 'n/a'}`);
    }
  }

  // The Shipping alignment card's basis: the last 7 days (today and the six
  // before), tracked (mapped) repos only, and the GitHub commits a sync matched
  // to Claude Code or Codex. github_repo_stats.date is TEXT (YYYY-MM-DD), so the
  // date-string param compares lexicographically. While Codex is hidden (or has
  // no data), commits matched to Codex count as no AI tool recorded, as there.
  const overlaySince = buildDailyWindow(new Date(now * 1000).toISOString().slice(0, 10), 7)[0];
  const splitKnown = sql`claude_commit_count IS NOT NULL AND codex_commit_count IS NOT NULL AND no_tool_commit_count IS NOT NULL`;
  const overlay = await rawGet<{ total: number | string; split_total: number | string; matched: number | string }>(client, sql`
    SELECT COALESCE(SUM(commit_count), 0) AS total,
           COALESCE(SUM(commit_count) FILTER (WHERE ${splitKnown}), 0) AS split_total,
           COALESCE(SUM(claude_commit_count${codexPresent ? sql` + codex_commit_count` : sql``}) FILTER (WHERE ${splitKnown}), 0) AS matched
    FROM github_repo_stats
    WHERE date >= ${overlaySince} AND repo IN (SELECT repo FROM github_repo_map)
  `);
  const overlayCount = Number(overlay?.total ?? 0);
  if (overlayCount > 0) {
    // Only when every commit in the window has been matched to a tool or none; otherwise no share.
    const share = Number(overlay?.split_total ?? 0) === overlayCount ? pctOf(Number(overlay?.matched ?? 0), overlayCount) : null;
    const shareKey = codexPresent ? 'share_of_shipped_commits_matched_to_claude_code_or_codex' : 'share_of_shipped_commits_matched_to_claude_code';
    lines.push(`github_overlay: total_commits_shipped_in_mapped_repos=${overlayCount}${share !== null ? `, ${shareKey}=${share}%` : ''}`);
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


  return lines.join('\n');
}

export async function generateCodeBriefing(): Promise<CodeBriefingRow> {
  const apiKey = await getConfigValue('anthropicAiApiKey');
  if (!apiKey) throw new Error('No AI API key configured');

  const codexPresent = await visibleOpenAi(hasCodexData());
  const summary = await buildDataSummary(codexPresent);
  if (!summary) throw new Error('No Developer Pulse metrics yet. The briefing needs at least one aggregation cycle');

  const model = (await getConfigValue('codeBriefingModel')) || (await getOrgBriefingModel());
  // Every number in the reply must come from the telemetry above; one retry,
  // then GroundingRejectedError (nothing stored, so last week's briefing stays).
  const { value: parsed } = await createGroundedJson({
    client: createAnthropicClient(apiKey),
    model,
    maxTokens: 4000,
    system: systemPrompt(codexPresent),
    userMessage: `Write this week's ${codexPresent ? 'Developer Pulse' : 'Claude Code'} briefing from this telemetry:\n\n${summary}`,
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
