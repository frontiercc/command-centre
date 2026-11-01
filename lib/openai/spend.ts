// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// ChatGPT and Codex spend, read from the OpenAI tables (migration 0040). Kept
// apart from Claude's spend: a page shows these figures only beside a Claude
// figure, each under its own label.
//
//   ChatGPT: OpenAI's own hourly cost records (product 'chatgpt'), in dollars,
//     or at OpenAI's estimated dollar value where the workspace is billed in
//     credits.
//   Codex: each turn's tokens priced from the rates table (Admin → Developer
//     Pulse rates), as Claude Code is priced; a model with no rate prices to
//     nothing and is named, never counted as $0. OpenAI's own estimate is
//     returned beside it for comparison.
import { sql, type SQL } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { getCodeModelRates, priceTokens, type ModelRates } from '@/lib/pulse/code/rates';

interface RawFacade {
  execute: (q: unknown) => Promise<{ rows: unknown[] }>;
}
async function rawAll<T>(query: unknown): Promise<T[]> {
  const client = (await getTypedClient()) as unknown as RawFacade;
  const res = await client.execute(query);
  return res.rows as T[];
}

function people(column: SQL, userIds: string[] | undefined): SQL {
  if (userIds === undefined) return sql`TRUE`;
  if (userIds.length === 0) return sql`FALSE`;
  return sql`${column} IN (${sql.join(userIds.map((id) => sql`${id}`), sql`, `)})`;
}

/**
 * ChatGPT spend (ChatGPT Chat and ChatGPT Work) since `since`, for everyone or
 * the given people. Null when no ChatGPT cost record has ever arrived, so a
 * page can say "not recorded" rather than show $0.
 */
export async function chatgptCostUsd(opts: { since: number; userIds?: string[] }): Promise<number | null> {
  const rows = await rawAll<{ any_cost: boolean; usd: string | number | null }>(sql`
    SELECT EXISTS (SELECT 1 FROM openai_costs WHERE product = 'chatgpt') AS any_cost,
           (SELECT COALESCE(SUM(cost_usd), 0) FROM openai_costs
             WHERE product = 'chatgpt' AND hour_start >= ${opts.since}
               AND ${people(sql`user_id`, opts.userIds)}) AS usd
  `);
  if (!rows[0]?.any_cost) return null;
  return Number(rows[0].usd ?? 0);
}

export interface CodexSpend {
  /** Priced from the rates table; null when no turn's model has a rate. */
  usd: number | null;
  /** OpenAI's own estimate for the same turns, for comparison. */
  openaiUsd: number;
  turns: number;
  /** Uncached input, cached input and output tokens across the turns. */
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  /** Models with no rate: their turns are not in `usd`. */
  unpricedModels: string[];
}

/** Codex spend since `since`, for everyone or the given people. */
export async function codexSpend(
  opts: { since: number; userIds?: string[] },
  rates?: ModelRates,
): Promise<CodexSpend> {
  const rows = await rawAll<{
    model: string | null; turns: string | number; uncached: string | number; cached: string | number;
    output: string | number; openai_usd: string | number | null;
  }>(sql`
    SELECT model, COUNT(*) AS turns,
           COALESCE(SUM(uncached_input_tokens), 0) AS uncached,
           COALESCE(SUM(cached_input_tokens), 0) AS cached,
           COALESCE(SUM(output_tokens), 0) AS output,
           COALESCE(SUM(openai_cost_usd), 0) AS openai_usd
    FROM codex_turns
    WHERE started_at >= ${opts.since} AND ${people(sql`user_id`, opts.userIds)}
    GROUP BY model
  `);
  const r = rates ?? await getCodeModelRates();
  let usd: number | null = null;
  let openaiUsd = 0;
  let turns = 0;
  let inputTokens = 0, cachedTokens = 0, outputTokens = 0;
  const unpriced: string[] = [];
  for (const row of rows) {
    turns += Number(row.turns);
    inputTokens += Number(row.uncached);
    cachedTokens += Number(row.cached);
    outputTokens += Number(row.output);
    openaiUsd += Number(row.openai_usd ?? 0);
    const priced = row.model === null ? null : priceTokens(row.model, {
      inputTokens: Number(row.uncached),
      outputTokens: Number(row.output),
      cacheReadTokens: Number(row.cached),
      cacheCreationTokens: 0,
    }, r);
    if (priced === null) unpriced.push(row.model ?? '(no model)');
    else usd = (usd ?? 0) + priced;
  }
  return { usd, openaiUsd, turns, inputTokens, cachedTokens, outputTokens, unpricedModels: unpriced.sort() };
}
