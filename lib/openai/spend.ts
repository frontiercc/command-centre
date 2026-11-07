// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// ChatGPT and Codex spend, read from the OpenAI tables (migration 0043). Kept
// apart from Claude's spend: a page shows these figures only beside a Claude
// figure, each under its own label.
//
//   ChatGPT: the tokens in OpenAI's hourly cost records (product 'chatgpt'),
//     priced from the rates table at OpenAI's published USD rates for
//     token-based Enterprise contracts, as Claude is priced at Anthropic's list
//     rates whatever the plan. OpenAI's own charge figure is returned beside it
//     for comparison.
//   Codex: each turn's tokens priced from the same rates table.
// A model with no rate prices to nothing and is named, never counted as $0.
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

export interface ChatgptSpend {
  /** Tokens × the rates table; models with no rate are left out and named below. */
  usd: number;
  /** OpenAI's own charge figure for the same records, for comparison. */
  openaiUsd: number;
  unpricedModels: string[];
}

/**
 * ChatGPT spend (ChatGPT Chat and ChatGPT Work) since `since`, for everyone or
 * the given people. Null when no ChatGPT cost record has ever arrived, so a
 * page can say "not recorded" rather than show $0.
 */
export async function chatgptSpend(opts: { since: number; userIds?: string[] }, rates?: ModelRates): Promise<ChatgptSpend | null> {
  const any = await rawAll<{ x: number }>(sql`SELECT 1 AS x FROM openai_costs WHERE product = 'chatgpt' LIMIT 1`);
  if (any.length === 0) return null;
  const rows = await rawAll<{ model: string | null; inp: string | number; cached: string | number; outp: string | number; openai_usd: string | number | null }>(sql`
    SELECT model, COALESCE(SUM(input_tokens), 0) AS inp, COALESCE(SUM(cached_input_tokens), 0) AS cached,
           COALESCE(SUM(output_tokens), 0) AS outp, COALESCE(SUM(cost_usd), 0) AS openai_usd
    FROM openai_costs
    WHERE product = 'chatgpt' AND hour_start >= ${opts.since} AND ${people(sql`user_id`, opts.userIds)}
    GROUP BY model
  `);
  const r = rates ?? await getCodeModelRates();
  let usd = 0;
  let openaiUsd = 0;
  const unpriced: string[] = [];
  for (const row of rows) {
    openaiUsd += Number(row.openai_usd ?? 0);
    const priced = row.model === null ? null : priceTokens(row.model, {
      inputTokens: Number(row.inp), outputTokens: Number(row.outp),
      cacheReadTokens: Number(row.cached), cacheCreationTokens: 0,
    }, r);
    if (priced === null) unpriced.push(row.model ?? '(no model)');
    else usd += priced;
  }
  return { usd, openaiUsd, unpricedModels: unpriced.sort() };
}

/** ChatGPT spend in dollars (see chatgptSpend), or null when no cost record has arrived. */
export async function chatgptCostUsd(opts: { since: number; userIds?: string[] }, rates?: ModelRates): Promise<number | null> {
  return (await chatgptSpend(opts, rates))?.usd ?? null;
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
