// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Work Pulse briefings' per-product facts: classified prompts and people for
// each of the four Work Pulse products, and the share of work at Tier 2 or 3
// for Claude and for OpenAI, worked out here so the model never calculates.
// Empty when no ChatGPT prompt was classified in the window, so a Claude-only
// hub's briefings are unchanged.
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { productExpr, vendorExpr } from '@/lib/dashboard/product-sql';
import { PRODUCTS } from '@/lib/dashboard/vendor';

const WORK_PULSE_PRODUCTS = PRODUCTS.filter(p => p.kind !== 'code');

export async function buildProductFacts(opts: {
  periodStart: number;
  periodEnd: number;
  /** Narrow to these people (a department or one person); everyone when absent. */
  userIds?: string[];
}): Promise<string[]> {
  const { periodStart, periodEnd, userIds } = opts;
  if (userIds && userIds.length === 0) return [];
  const client = await getTypedClient();
  const pc = schema.pulseClassifications;
  const cm = schema.coworkMessages;
  const product = sql.raw(productExpr('cowork_messages.'));
  const vendor = sql.raw(vendorExpr('cowork_messages.'));
  const where = and(
    eq(pc.classifier_status, 'classified'),
    gte(cm.occurred_at, periodStart), lt(cm.occurred_at, periodEnd),
    userIds ? inArray(pc.user_id, userIds) : undefined,
  );

  const byProduct = await client
    .select({
      product: sql<string>`${product}`,
      prompts: sql<number | string>`COUNT(*)`,
      people: sql<number | string>`COUNT(DISTINCT ${pc.user_id})`,
    })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .where(where)
    .groupBy(product);
  const counts = new Map(byProduct.map(r => [r.product, { prompts: Number(r.prompts), people: Number(r.people) }]));
  const openaiPrompts = (counts.get('chatgpt_chat')?.prompts ?? 0) + (counts.get('chatgpt_work')?.prompts ?? 0);
  if (openaiPrompts === 0) return [];

  const byVendor = await client
    .select({
      vendor: sql<string>`${vendor}`,
      total: sql<number | string>`COUNT(*)`,
      deep: sql<number | string>`SUM(CASE WHEN ${pc.tier} >= 2 THEN 1 ELSE 0 END)`,
    })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .where(where)
    .groupBy(vendor);
  const share = (v: 'claude' | 'openai') => {
    const row = byVendor.find(r => r.vendor === v);
    const total = Number(row?.total ?? 0);
    return total > 0 ? `${Math.round((Number(row?.deep ?? 0) / total) * 100)}%` : 'no work';
  };

  const lines = WORK_PULSE_PRODUCTS.map(p => {
    const c = counts.get(p.id) ?? { prompts: 0, people: 0 };
    return `${p.label}: ${c.prompts} classified prompts, ${c.people} ${c.people === 1 ? 'person' : 'people'}`;
  });
  lines.push(`Share of work at Tier 2 or 3: Claude ${share('claude')}, ChatGPT ${share('openai')}`);
  return lines;
}

/** The PRODUCTS block for a briefing prompt, or nothing when there are no facts. */
export function productFactsBlock(lines: string[]): string {
  if (lines.length === 0) return '';
  return `\nPRODUCTS (the figures above cover all four; ChatGPT prompts come from OpenAI's export)\n${lines.join('\n')}\n`;
}

/** The instruction added to a briefing's system prompt. */
export const PRODUCT_NAMING_RULE = 'If a PRODUCTS section is given, name the products as written there (Claude Cowork, Claude Chat, ChatGPT Work, ChatGPT Chat) wherever you refer to one, and never call ChatGPT work Cowork.';
