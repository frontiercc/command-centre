// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Prompts and people per product, for the report: Claude Chat, Claude Cowork
// and Claude Code, and ChatGPT Chat, ChatGPT Work and Codex once the OpenAI
// export has sent any. Read from cowork_messages with the dashboard's own
// product rule (lib/dashboard/product-sql.ts productExpr), so the report and
// the dashboard name each row the same way. Prompts only: the person's
// messages, not tool or model-call rows.
import { sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { productExpr } from '@/lib/dashboard/product-sql';
import { PRODUCTS, type ProductId } from '@/lib/dashboard/vendor';

export interface ProductFigure {
  id: ProductId;
  label: string;
  vendor: 'claude' | 'openai';
  /** Every prompt captured, and those flagged for personal data or intent. */
  prompts: number;
  flagged: number;
  /** The last 7 days, and the 7 days before, for week-on-week change. */
  last7: number;
  prior7: number;
  peopleLast7: number;
  /** Within the report period. */
  promptsInPeriod: number;
  peopleInPeriod: number;
}

interface RawFacade {
  execute: (q: unknown) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** Figures for every product with any prompt; a product never seen is left out. */
export async function getProductFigures(periodStartS: number, periodEndS: number, nowS: number = Math.floor(Date.now() / 1000)): Promise<ProductFigure[]> {
  const raw = (await getTypedClient()) as unknown as RawFacade;
  const weekAgo = nowS - 7 * 86400;
  const twoWeeksAgo = nowS - 14 * 86400;
  const res = await raw.execute(sql`
    SELECT ${sql.raw(productExpr())} AS product,
           COUNT(*) AS prompts,
           COUNT(*) FILTER (WHERE flagged = 1) AS flagged,
           COUNT(*) FILTER (WHERE occurred_at >= ${weekAgo}) AS last7,
           COUNT(*) FILTER (WHERE occurred_at >= ${twoWeeksAgo} AND occurred_at < ${weekAgo}) AS prior7,
           COUNT(DISTINCT user_id) FILTER (WHERE occurred_at >= ${weekAgo}) AS people_last7,
           COUNT(*) FILTER (WHERE occurred_at >= ${periodStartS} AND occurred_at < ${periodEndS}) AS in_period,
           COUNT(DISTINCT user_id) FILTER (WHERE occurred_at >= ${periodStartS} AND occurred_at < ${periodEndS}) AS people_in_period
      FROM cowork_messages
     WHERE message_type IN ('cowork_user_message', 'code_user_message')
     GROUP BY 1`);
  const byId = new Map(res.rows.map(r => [String(r.product), r]));
  return PRODUCTS.flatMap(p => {
    const r = byId.get(p.id);
    if (!r) return [];
    return [{
      id: p.id, label: p.label, vendor: p.vendor,
      prompts: Number(r.prompts), flagged: Number(r.flagged),
      last7: Number(r.last7), prior7: Number(r.prior7), peopleLast7: Number(r.people_last7),
      promptsInPeriod: Number(r.in_period), peopleInPeriod: Number(r.people_in_period),
    }];
  });
}

/** The product a cowork_messages row belongs to, by message id, for labelling alerts. */
export async function productsForMessages(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const raw = (await getTypedClient()) as unknown as RawFacade;
  const res = await raw.execute(sql`
    SELECT id, ${sql.raw(productExpr())} AS product FROM cowork_messages
     WHERE id IN (${sql.join(ids.map(i => sql`${i}`), sql`, `)})`);
  const label = new Map<string, string>(PRODUCTS.map(p => [p.id, p.label]));
  for (const r of res.rows) out.set(String(r.id), label.get(String(r.product)) ?? String(r.product));
  return out;
}
