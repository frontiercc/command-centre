// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Work Pulse "By product" panel: Cowork beside each Claude in Office and
 * Claude in Google app.
 *
 * Office and Google rows live in cowork_messages beside Cowork, told apart by
 * `product` (NULL = Cowork; excel / word / powerpoint / outlook, migration 0039;
 * sheets / docs / slides). This
 * reads them over the last 30 days, the window of the overview's Meaningful
 * work headline, per product, plus an All products row that equals it:
 *
 *   people / sessions   measured, from each product's prompts
 *   meaningfulPct       AI-judged, share of classified prompts at Tier 2 or 3,
 *                       held back below MIN_JUDGED_FOR_RATE judged prompts
 *   producedPct         measured, share of those sessions that produced
 *                       something (cowork_session_stats.produced_output), held back
 *                       below MIN_SESSIONS_FOR_RATE sessions like the
 *                       Session Output card
 *   spendUsd            Cowork: the reported cost Claude sends. Office sends
 *                       tokens and no cost, so its spend is priced from the
 *                       admin rates table and marked an estimate. The All
 *                       products row adds them and is then an estimate too.
 *
 * Null always means "not measured", never zero. Every product always has a
 * row, so the panel shows before Office activity arrives (hasOffice says so).
 */
import { and, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { officeSpendByUser, summariseOfficeSpend } from '@/lib/finance/office-spend';
import { MIN_SESSIONS_FOR_RATE } from '@/lib/pulse/cowork/session-output-rate';

/** Fewest judged prompts a product needs before its Meaningful work share shows. */
export const MIN_JUDGED_FOR_RATE = 5;
import { PRODUCT_FAMILY, PRODUCT_ORDER, type WorkProduct } from '@/lib/pulse/cowork/products';

/** Same window as the overview's "Meaningful work" headline, so the panel breaks that figure down. */
export const BY_PRODUCT_WINDOW_DAYS = 30;

export interface ProductRow {
  product: WorkProduct | 'all';
  people: number;
  sessions: number;
  meaningfulPct: number | null;
  producedPct: number | null;
  spendUsd: number | null;
  /** True for Office: priced from the admin rates, not reported by Claude. */
  spendEstimated: boolean;
  /** Office models with no rate in the admin table: their spend is left out. */
  unpricedModels: string[];
}

const productKey = sql<string>`COALESCE(${schema.coworkMessages.product}, 'cowork')`;

function asProduct(v: string): WorkProduct | null {
  return (PRODUCT_ORDER as readonly string[]).includes(v) ? (v as WorkProduct) : null;
}

export interface ByProduct {
  rows: ProductRow[];
  /**
   * All products together. Its meaningfulPct is worked out exactly as the
   * overview headline is (app/api/pulse/cio: classifications made in
   * the last 30 days), so the two always match. spendUsd adds every row's
   * spend; it is an estimate whenever an Office estimate is part of it.
   */
  total: ProductRow;
  /** False until any Office or Google activity arrives. */
  hasOffice: boolean;
  /** Which groups had activity: the panel says how to set up a group with none. */
  seen: { office: boolean; google: boolean };
}

export async function buildByProduct(nowS = Math.floor(Date.now() / 1000)): Promise<ByProduct | null> {
  const client = await getTypedClient();
  const cm = schema.coworkMessages;
  const since = nowS - BY_PRODUCT_WINDOW_DAYS * 86400;
  const inWindow = and(
    sql`COALESCE(${cm.surface}, 'cowork') = 'cowork'`,
    gte(cm.occurred_at, since),
  );

  const usage = await client
    .select({
      product: productKey,
      people: sql<number | string>`COUNT(DISTINCT ${cm.user_id})`,
      sessions: sql<number | string>`COUNT(DISTINCT ${cm.session_id})`,
    })
    .from(cm)
    .where(and(inWindow, eq(cm.message_type, 'cowork_user_message')))
    .groupBy(productKey);

  // Every product always has a row (never hide the panel until Office fills
  // it): an app with no activity reads 0 app users and 0 sessions, and its
  // rates and spend stay blank (not measured), never 0%.
  const rows = new Map<WorkProduct, ProductRow>();
  for (const p of PRODUCT_ORDER) {
    rows.set(p, {
      product: p, people: 0, sessions: 0,
      meaningfulPct: null, producedPct: null, spendUsd: null,
      spendEstimated: p !== 'cowork', unpricedModels: [],
    });
  }
  for (const u of usage) {
    const p = asProduct(u.product);
    if (!p) continue;
    rows.set(p, {
      product: p, people: Number(u.people), sessions: Number(u.sessions),
      meaningfulPct: null, producedPct: null, spendUsd: null,
      spendEstimated: p !== 'cowork', unpricedModels: [],
    });
  }
  const active = [...rows.values()].filter(r => r.sessions > 0);
  const seen = {
    office: active.some(r => PRODUCT_FAMILY[r.product as WorkProduct] === 'office'),
    google: active.some(r => PRODUCT_FAMILY[r.product as WorkProduct] === 'google'),
  };
  const hasOffice = seen.office || seen.google;

  // Meaningful work: classified prompts at Tier 2 or 3, by when they were
  // classified, which is the overview headline's rule (app/api/pulse/cio).
  // A product with fewer than MIN_JUDGED_FOR_RATE judged prompts stays blank,
  // so one prompt never reads as 0% or 100%. All products has no floor: it
  // equals the headline.
  const pc = schema.pulseClassifications;
  const classifiedInWindow = and(gte(pc.classified_at, since), eq(pc.classifier_status, 'classified'));
  const tiers = await client
    .select({
      product: productKey,
      total: sql<number | string>`COUNT(*)`,
      meaningful: sql<number | string>`COUNT(*) FILTER (WHERE ${pc.tier} >= 2)`,
    })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .where(classifiedInWindow)
    .groupBy(productKey);
  for (const t of tiers) {
    const row = rows.get(asProduct(t.product) as WorkProduct);
    const total = Number(t.total);
    if (row && total >= MIN_JUDGED_FOR_RATE) row.meaningfulPct = Math.round((Number(t.meaningful) / total) * 100);
  }

  // Produced something: of the sessions in the Sessions column (a prompt in the
  // window), the share with a measured answer that produced something. Reading
  // every stats row started in the window instead also counted sessions with no
  // prompt at all, which on a demo hub outnumbered the real ones 18 to 1 and
  // pulled Cowork and All products to near zero.
  const cs = schema.coworkSessions;
  const css = schema.coworkSessionStats;
  const promptedSessions = client
    .selectDistinct({ id: cm.session_id })
    .from(cm)
    .where(and(inWindow, eq(cm.message_type, 'cowork_user_message')));
  const sessionProduct = sql<string>`COALESCE(${cs.product}, 'cowork')`;
  const produced = await client
    .select({
      product: sessionProduct,
      measured: sql<number | string>`COUNT(*)`,
      yes: sql<number | string>`COUNT(*) FILTER (WHERE ${css.produced_output} = 1)`,
    })
    .from(css)
    .innerJoin(cs, eq(cs.id, css.session_id))
    .where(and(inArray(css.session_id, promptedSessions), isNotNull(css.produced_output)))
    .groupBy(sessionProduct);
  for (const r of produced) {
    const row = rows.get(asProduct(r.product) as WorkProduct);
    const measured = Number(r.measured);
    if (row && measured >= MIN_SESSIONS_FOR_RATE) row.producedPct = Math.round((Number(r.yes) / measured) * 100);
  }

  // Spend. Cowork: the reported cost. Office: the shared estimate
  // (lib/finance/office-spend.ts), the same figure FinOps and Spend Review show.
  const [coworkCost] = await client
    .select({ usd: sql<string | null>`SUM(${cm.cost_usd})` })
    .from(cm)
    .where(and(inWindow, eq(cm.message_type, 'cowork_api_request'), isNull(cm.product)));
  const coworkRow = rows.get('cowork');
  if (coworkRow && coworkCost?.usd !== null && coworkCost?.usd !== undefined) coworkRow.spendUsd = Number(coworkCost.usd);
  const office = summariseOfficeSpend(await officeSpendByUser(since, nowS + 1));
  for (const o of office?.byProduct ?? []) {
    const row = rows.get(o.product);
    if (!row) continue;
    row.spendUsd = o.usd;
    row.unpricedModels = o.unpricedModels;
  }

  // All products: each session belongs to one product, so this equals the rows' sum.
  const [all] = await client
    .select({
      sessions: sql<number | string>`COUNT(DISTINCT ${cm.session_id})`,
    })
    .from(cm)
    .where(and(inWindow, eq(cm.message_type, 'cowork_user_message')));
  const [allTiers] = await client
    .select({
      total: sql<number | string>`COUNT(*)`,
      meaningful: sql<number | string>`COUNT(*) FILTER (WHERE ${pc.tier} >= 2)`,
    })
    .from(pc)
    .where(classifiedInWindow);
  const [allProduced] = await client
    .select({
      measured: sql<number | string>`COUNT(*)`,
      yes: sql<number | string>`COUNT(*) FILTER (WHERE ${css.produced_output} = 1)`,
    })
    .from(css)
    .where(and(inArray(css.session_id, promptedSessions), isNotNull(css.produced_output)));
  const tierTotal = Number(allTiers?.total ?? 0);
  const producedTotal = Number(allProduced?.measured ?? 0);
  const spendRows = [...rows.values()].filter(r => r.spendUsd !== null);
  const total: ProductRow = {
    product: 'all',
    // App users: a person counts once for each product they used, so the column adds up.
    people: [...rows.values()].reduce((n, r) => n + r.people, 0),
    sessions: Number(all?.sessions ?? 0),
    meaningfulPct: tierTotal > 0 ? Math.round((Number(allTiers.meaningful) / tierTotal) * 100) : null,
    producedPct: producedTotal >= MIN_SESSIONS_FOR_RATE ? Math.round((Number(allProduced.yes) / producedTotal) * 100) : null,
    spendUsd: spendRows.length > 0 ? spendRows.reduce((n, r) => n + (r.spendUsd ?? 0), 0) : null,
    spendEstimated: spendRows.some(r => r.spendEstimated),
    unpricedModels: [],
  };

  return { rows: PRODUCT_ORDER.map(p => rows.get(p)!), total, hasOffice, seen };
}
