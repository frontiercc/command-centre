// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * When the hub last RECEIVED anything from ChatGPT and from Codex, as two
 * separate sources (ingested_at, not when the work happened: OpenAI's export
 * runs behind, so a late file with old timestamps still proves the sync is
 * bringing data). One calculation for the System health card's rows and the
 * telemetry-silence alert, so the two never disagree.
 *
 *   ChatGPT: ChatGPT Chat and Work prompts, reply times, non-Codex spend.
 *   Codex:   Codex prompts, turns, actions, Codex spend.
 *
 * null = nothing ever received from that source.
 */
import { sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';

export interface OpenAiArrivals {
  chatgpt: number | null;
  codex: number | null;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function readOpenAiLastArrivals(): Promise<OpenAiArrivals> {
  const client = await getTypedClient();
  const res = await client.execute(sql`
    SELECT
      GREATEST(
        (SELECT MAX(ingested_at) FROM cowork_messages WHERE source IN ('chatgpt_chat', 'chatgpt_work')),
        (SELECT MAX(ingested_at) FROM openai_replies),
        (SELECT MAX(ingested_at) FROM openai_costs WHERE product <> 'codex')) AS chatgpt,
      GREATEST(
        (SELECT MAX(ingested_at) FROM cowork_messages WHERE source = 'codex'),
        (SELECT MAX(ingested_at) FROM codex_turns),
        (SELECT MAX(ingested_at) FROM codex_actions),
        (SELECT MAX(ingested_at) FROM openai_costs WHERE product = 'codex')) AS codex`);
  const row = (res as unknown as { rows: Array<{ chatgpt: unknown; codex: unknown }> }).rows[0];
  return { chatgpt: num(row?.chatgpt), codex: num(row?.codex) };
}
