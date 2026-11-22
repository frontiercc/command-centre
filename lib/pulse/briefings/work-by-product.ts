// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Where the work happened, for the CIO and department briefings: sessions and
 * people per product (Claude Chat, Cowork, each Claude in Office and Claude in
 * Google app, and ChatGPT) over the period, so the model can compare products.
 * Measured, from the person's own prompts in cowork_messages (Office rows carry
 * `product`, NULL = Cowork; Claude Chat is surface 'chat'; ChatGPT is its own
 * sources), the same rule as the Work Pulse By product panel. A person counts
 * once in each product they used.
 *
 * Returns no lines when only one product was used in the period. Office and
 * Google rows are left out when Claude in Office is hidden (Admin → Work Pulse),
 * and ChatGPT when it is hidden on the OpenAI panel.
 */
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { briefingCount } from '@/lib/pulse/briefings/format';
import { schema } from '@/lib/db/schema';
import { getConfigValue } from '@/lib/config';
import { openaiShown } from '@/lib/sources/openai-visibility';
import { OPENAI_SOURCES } from '@/lib/openai/sources';
import { PRODUCT_ORDER, productFullName, type WorkProduct } from '@/lib/pulse/cowork/products';

export type ActivityProduct = 'claude_chat' | WorkProduct | 'chatgpt';
export interface ProductActivity { product: ActivityProduct; sessions: number; people: number }

const ORDER: ActivityProduct[] = ['claude_chat', ...PRODUCT_ORDER, 'chatgpt'];
// Fixed source names as literal SQL (not parameters), so the same expression can be selected and grouped by.
const OPENAI_LIST = sql.raw(OPENAI_SOURCES.map(s => `'${s}'`).join(', '));

export async function readWorkByProduct(userIds: string[] | null, sinceS: number, untilS: number): Promise<ProductActivity[]> {
  if (userIds && userIds.length === 0) return [];
  const client = await getTypedClient();
  const cm = schema.coworkMessages;
  // ChatGPT Work prompts share the Cowork surface and a NULL product, so they are
  // keyed by source first and never counted as Cowork.
  const productKey = sql<string>`CASE WHEN ${cm.source} IN (${OPENAI_LIST}) THEN 'chatgpt'
    WHEN ${cm.surface} = 'chat' THEN 'claude_chat'
    ELSE COALESCE(${cm.product}, 'cowork') END`;
  const rows = await client
    .select({
      product: productKey,
      sessions: sql<number | string>`COUNT(DISTINCT ${cm.session_id})`,
      people: sql<number | string>`COUNT(DISTINCT ${cm.user_id})`,
    })
    .from(cm)
    .where(and(
      sql`COALESCE(${cm.surface}, 'cowork') IN ('cowork', 'chat')`,
      eq(cm.message_type, 'cowork_user_message'),
      gte(cm.occurred_at, sinceS),
      lt(cm.occurred_at, untilS),
      ...(userIds ? [inArray(cm.user_id, userIds)] : []),
    ))
    .groupBy(productKey);
  const byProduct = new Map(rows.map(r => [r.product, r]));
  return ORDER
    .filter(p => byProduct.has(p))
    .map(p => ({ product: p, sessions: Number(byProduct.get(p)!.sessions), people: Number(byProduct.get(p)!.people) }));
}

function productName(p: ActivityProduct): string {
  if (p === 'claude_chat') return 'Claude Chat';
  if (p === 'chatgpt') return 'ChatGPT';
  if (p === 'cowork') return 'Cowork';
  return `Claude in ${productFullName(p)}`;
}

/** Pure: the briefing lines, or none when fewer than two products were used. States the list's count. */
export function workByProductLines(activity: ProductActivity[]): string[] {
  const used = activity.filter(a => a.sessions > 0);
  if (used.length < 2) return [];
  return [
    `Where the work happened, ${used.length} products in total (measured sessions and people):`,
    ...used.map(a => `${productName(a.product)}: ${briefingCount(a.sessions)} ${a.sessions === 1 ? 'session' : 'sessions'} by ${briefingCount(a.people)} ${a.people === 1 ? 'person' : 'people'}`),
  ];
}

/** Lines for a briefing; empty when fewer than two products were used, or on any failure. */
export async function workByProductFacts(userIds: string[] | null, sinceS: number, untilS: number): Promise<string[]> {
  try {
    const officeShown = (await getConfigValue('claudeInOfficeShown')) !== 'false';
    const chatgptShown = await openaiShown();
    const activity = (await readWorkByProduct(userIds, sinceS, untilS)).filter(a =>
      a.product === 'chatgpt' ? chatgptShown
        : a.product === 'claude_chat' || a.product === 'cowork' ? true
        : officeShown);
    return workByProductLines(activity);
  } catch {
    return [];
  }
}
