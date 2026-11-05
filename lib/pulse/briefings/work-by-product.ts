// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Where the work happened, for the CIO and department briefings: sessions and
 * people per product (Cowork and each Claude in Office app) over the period.
 * Measured, from the person's own prompts in cowork_messages (Office rows carry
 * `product`, NULL = Cowork), the same rule as the Work Pulse By product panel.
 *
 * Returns no lines when there is no Office activity in the period, or when
 * Claude in Office is hidden (Admin → Work Pulse), so a hub without Office
 * monitoring reads exactly as before.
 */
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue } from '@/lib/config';
import { PRODUCT_LABEL, PRODUCT_ORDER, type WorkProduct } from '@/lib/pulse/cowork/products';

export interface ProductActivity { product: WorkProduct; sessions: number; people: number }

export async function readWorkByProduct(userIds: string[] | null, sinceS: number, untilS: number): Promise<ProductActivity[]> {
  if (userIds && userIds.length === 0) return [];
  const client = await getTypedClient();
  const cm = schema.coworkMessages;
  const productKey = sql<string>`COALESCE(${cm.product}, 'cowork')`;
  const rows = await client
    .select({
      product: productKey,
      sessions: sql<number | string>`COUNT(DISTINCT ${cm.session_id})`,
      people: sql<number | string>`COUNT(DISTINCT ${cm.user_id})`,
    })
    .from(cm)
    .where(and(
      sql`COALESCE(${cm.surface}, 'cowork') = 'cowork'`,
      eq(cm.message_type, 'cowork_user_message'),
      gte(cm.occurred_at, sinceS),
      lt(cm.occurred_at, untilS),
      ...(userIds ? [inArray(cm.user_id, userIds)] : []),
    ))
    .groupBy(productKey);
  const byProduct = new Map(rows.map(r => [r.product, r]));
  return PRODUCT_ORDER
    .filter(p => byProduct.has(p))
    .map(p => ({ product: p, sessions: Number(byProduct.get(p)!.sessions), people: Number(byProduct.get(p)!.people) }));
}

/** Pure: the briefing lines, or none when no Office app was used. States the list's count. */
export function workByProductLines(activity: ProductActivity[]): string[] {
  const office = activity.filter(a => a.product !== 'cowork' && a.sessions > 0);
  if (office.length === 0) return [];
  const used = activity.filter(a => a.sessions > 0);
  return [
    `Where the work happened, ${used.length} products in total (measured sessions and people):`,
    ...used.map(a => `${a.product === 'cowork' ? 'Cowork' : `Claude in ${PRODUCT_LABEL[a.product]}`}: ${a.sessions} sessions by ${a.people} ${a.people === 1 ? 'person' : 'people'}`),
  ];
}

/** Lines for a briefing; empty when hidden, when Office was not used, or on any failure. */
export async function workByProductFacts(userIds: string[] | null, sinceS: number, untilS: number): Promise<string[]> {
  try {
    if ((await getConfigValue('claudeInOfficeShown')) === 'false') return [];
    return workByProductLines(await readWorkByProduct(userIds, sinceS, untilS));
  } catch {
    return [];
  }
}
