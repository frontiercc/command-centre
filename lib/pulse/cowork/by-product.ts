// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Work Pulse "By product" panel: every product Work Pulse covers, side by side.
 *
 *   Claude Chat   cowork_messages surface 'chat' (moved in by migration 0041)
 *   Cowork        surface 'cowork', `product` NULL, Claude's (not ChatGPT's)
 *   Office apps   surface 'cowork', `product` excel / word / powerpoint / outlook
 *   Google apps   surface 'cowork', `product` sheets / docs / slides
 *   ChatGPT       source chatgpt_chat / chatgpt_work: one row, because OpenAI
 *                 reports ChatGPT spend as one product
 *
 * Read over the last 30 days, the window of the overview's Meaningful work
 * headline, per product, plus an All products row that equals it:
 *
 *   people / sessions   measured, from each product's prompts
 *   meaningfulPct       AI-judged, share of classified prompts at Tier 2 or 3,
 *                       held back below MIN_JUDGED_FOR_RATE judged prompts
 *   producedPct         measured, share of those sessions that produced
 *                       something (cowork_session_stats.produced_output), held back
 *                       below MIN_SESSIONS_FOR_RATE sessions like the Session
 *                       Output card. Only Claude's telemetry builds session
 *                       stats, so Claude Chat and ChatGPT stay not measured.
 *   spendUsd            Cowork: the reported cost Claude sends. Office and
 *                       Google send tokens and no cost, so theirs is priced
 *                       from the rates table and marked an estimate. ChatGPT:
 *                       its tokens priced at OpenAI's rates, the figure the
 *                       rest of Work Pulse shows (lib/openai/spend.ts), also
 *                       marked as priced from rates. Claude Chat: not measured.
 *
 * The panel follows the Work Pulse vendor switch: Claude shows Claude's rows,
 * OpenAI shows the ChatGPT row, All shows both, and All products always
 * covers the rows of that view. Null always means "not measured", never zero.
 */
import { and, eq, gte, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { officeSpendByUser, summariseOfficeSpend } from '@/lib/finance/office-spend';
import { chatgptSpend } from '@/lib/openai/spend';
import { MIN_SESSIONS_FOR_RATE } from '@/lib/pulse/cowork/session-output-rate';
import { PRODUCT_FAMILY, PRODUCT_ORDER, type WorkProduct } from '@/lib/pulse/cowork/products';
import { OPENAI_SOURCES } from '@/lib/openai/sources';
import { messageVendor } from '@/lib/pulse/vendor-filter';
import type { Vendor } from '@/lib/dashboard/vendor';

/** Fewest judged prompts a product needs before its Meaningful work share shows. */
export const MIN_JUDGED_FOR_RATE = 5;

/** Same window as the overview's "Meaningful work" headline, so the panel breaks that figure down. */
export const BY_PRODUCT_WINDOW_DAYS = 30;

/** A row on the panel: Claude Chat, Cowork, an Office or Google app, or ChatGPT. */
export type PanelProduct = 'claude_chat' | WorkProduct | 'chatgpt';

export interface ProductRow {
  product: PanelProduct | 'all';
  people: number;
  sessions: number;
  meaningfulPct: number | null;
  producedPct: number | null;
  spendUsd: number | null;
  /** True for Office, Google and ChatGPT: priced from the rates table, not a cost the product reports. */
  spendEstimated: boolean;
  /** Models with no rate in the table: their spend is left out. */
  unpricedModels: string[];
}

// Fixed source names as literal SQL (not parameters), so the same expression can be selected and grouped by.
const OPENAI_LIST = sql.raw(OPENAI_SOURCES.map(s => `'${s}'`).join(', '));

/** The panel row a cowork_messages row belongs to. */
function rowKeyOf(cm: typeof schema.coworkMessages): SQL<string> {
  return sql<string>`CASE WHEN ${cm.source} IN (${OPENAI_LIST}) THEN 'chatgpt'
    WHEN ${cm.surface} = 'chat' THEN 'claude_chat'
    ELSE COALESCE(${cm.product}, 'cowork') END`;
}

function isPanelProduct(v: string, order: readonly PanelProduct[]): v is PanelProduct {
  return (order as readonly string[]).includes(v);
}

export interface ByProduct {
  rows: ProductRow[];
  /**
   * All products together, for the view shown. Its meaningfulPct is worked
   * out exactly as the overview headline is (app/api/pulse/cio: classifications
   * made in the last 30 days, in that view), so the two always match. spendUsd
   * adds every row's spend; it is an estimate whenever an estimate is part of it.
   */
  total: ProductRow;
  /** False until any Office or Google activity arrives. */
  hasOffice: boolean;
  /** Which groups had activity: the panel says how to set up a group with none. */
  seen: { office: boolean; google: boolean };
}

export interface ByProductOptions {
  /** The Work Pulse vendor switch. Default 'all'. */
  vendor?: Vendor;
  /** Show the Office and Google rows (Admin → Work Pulse). Default true. */
  officeShown?: boolean;
  /** Show the ChatGPT row: OpenAI connected and shown. Default false. */
  chatgpt?: boolean;
  /** Show Claude's rows: false on an install with only OpenAI connected. Default true. */
  claude?: boolean;
}

export async function buildByProduct(
  nowS = Math.floor(Date.now() / 1000),
  opts: ByProductOptions = {},
): Promise<ByProduct | null> {
  const vendor = opts.vendor ?? 'all';
  const showClaude = (opts.claude ?? true) && vendor !== 'openai';
  const showChatgpt = (opts.chatgpt ?? false) && vendor !== 'claude';
  const officeShown = opts.officeShown ?? true;
  const order: PanelProduct[] = [
    ...(showClaude ? (['claude_chat', ...PRODUCT_ORDER.filter(p => officeShown || p === 'cowork')] as PanelProduct[]) : []),
    ...(showChatgpt ? (['chatgpt'] as PanelProduct[]) : []),
  ];
  if (order.length === 0) return null;

  // The rows' vendor: with the ChatGPT row not shown (OpenAI not connected, or
  // hidden on the OpenAI panel) the All view is Claude's, and the reverse on an
  // install with only OpenAI connected.
  const viewVendor: Vendor = vendor !== 'all' ? vendor : !showChatgpt ? 'claude' : !showClaude ? 'openai' : 'all';

  const client = await getTypedClient();
  const cm = schema.coworkMessages;
  const since = nowS - BY_PRODUCT_WINDOW_DAYS * 86400;
  const rowKey = rowKeyOf(cm);
  // Work Pulse's prompts (Cowork, Office, Google, ChatGPT and Claude Chat) in the
  // window, in the view shown. A vendor view keeps its own vendor's rows.
  const inView = and(
    sql`COALESCE(${cm.surface}, 'cowork') IN ('cowork', 'chat')`,
    gte(cm.occurred_at, since),
    viewVendor === 'all' ? undefined : messageVendor(viewVendor),
  );

  const usage = await client
    .select({
      product: rowKey,
      people: sql<number | string>`COUNT(DISTINCT ${cm.user_id})`,
      sessions: sql<number | string>`COUNT(DISTINCT ${cm.session_id})`,
    })
    .from(cm)
    .where(and(inView, eq(cm.message_type, 'cowork_user_message')))
    .groupBy(rowKey);

  // Every product always has a row (never hide the panel until Office fills
  // it): a product with no activity reads 0 app users and 0 sessions, and its
  // rates and spend stay blank (not measured), never 0%.
  const blank = (p: PanelProduct): ProductRow => ({
    product: p, people: 0, sessions: 0,
    meaningfulPct: null, producedPct: null, spendUsd: null,
    spendEstimated: p !== 'cowork' && p !== 'claude_chat', unpricedModels: [],
  });
  const rows = new Map<PanelProduct, ProductRow>(order.map(p => [p, blank(p)]));
  for (const u of usage) {
    if (!isPanelProduct(u.product, order)) continue;
    rows.set(u.product, { ...blank(u.product), people: Number(u.people), sessions: Number(u.sessions) });
  }
  const officeActive = (family: 'office' | 'google') => [...rows.values()].some(r =>
    r.sessions > 0 && r.product !== 'claude_chat' && r.product !== 'chatgpt' && r.product !== 'all'
    && PRODUCT_FAMILY[r.product] === family);
  const seen = { office: officeActive('office'), google: officeActive('google') };
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
      product: rowKey,
      total: sql<number | string>`COUNT(*)`,
      meaningful: sql<number | string>`COUNT(*) FILTER (WHERE ${pc.tier} >= 2)`,
    })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .where(and(classifiedInWindow, viewVendor === 'all' ? undefined : messageVendor(viewVendor)))
    .groupBy(rowKey);
  for (const t of tiers) {
    const row = isPanelProduct(t.product, order) ? rows.get(t.product) : undefined;
    const total = Number(t.total);
    if (row && total >= MIN_JUDGED_FOR_RATE) row.meaningfulPct = Math.round((Number(t.meaningful) / total) * 100);
  }

  // Produced something: of the sessions in the Sessions column (a prompt in the
  // window), the share with a measured answer that produced something. Reading
  // every stats row started in the window instead also counted sessions with no
  // prompt at all, which on a demo hub outnumbered the real ones 18 to 1 and
  // pulled Cowork and All products to near zero. Session stats are built from
  // Claude's telemetry only, so Claude Chat and ChatGPT sessions have none.
  const cs = schema.coworkSessions;
  const css = schema.coworkSessionStats;
  const promptedSessions = client
    .selectDistinct({ id: cm.session_id })
    .from(cm)
    .where(and(inView, eq(cm.message_type, 'cowork_user_message')));
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
    const row = isPanelProduct(r.product, order) ? rows.get(r.product) : undefined;
    const measured = Number(r.measured);
    if (row && measured >= MIN_SESSIONS_FOR_RATE) row.producedPct = Math.round((Number(r.yes) / measured) * 100);
  }

  // Spend. Cowork: the reported cost, Claude's own (ChatGPT rows carry none).
  // Office and Google: the shared estimate (lib/finance/office-spend.ts), the
  // same figure FinOps and Spend Review show. ChatGPT: the figure the rest of
  // Work Pulse and FinOps show.
  const coworkRow = rows.get('cowork');
  if (coworkRow) {
    const [coworkCost] = await client
      .select({ usd: sql<string | null>`SUM(${cm.cost_usd})` })
      .from(cm)
      .where(and(
        sql`COALESCE(${cm.surface}, 'cowork') = 'cowork'`, gte(cm.occurred_at, since),
        eq(cm.message_type, 'cowork_api_request'), isNull(cm.product), messageVendor('claude'),
      ));
    if (coworkCost?.usd !== null && coworkCost?.usd !== undefined) coworkRow.spendUsd = Number(coworkCost.usd);
  }
  if (showClaude && officeShown) {
    const office = summariseOfficeSpend(await officeSpendByUser(since, nowS + 1));
    for (const o of office?.byProduct ?? []) {
      const row = rows.get(o.product);
      if (!row) continue;
      row.spendUsd = o.usd;
      row.unpricedModels = o.unpricedModels;
    }
  }
  const chatgptRow = rows.get('chatgpt');
  if (chatgptRow) {
    const spend = await chatgptSpend({ since });
    if (spend) {
      chatgptRow.spendUsd = spend.usd;
      chatgptRow.unpricedModels = spend.unpricedModels;
    }
  }

  // All products: each session belongs to one product, so this equals the rows' sum.
  const [all] = await client
    .select({ sessions: sql<number | string>`COUNT(DISTINCT ${cm.session_id})` })
    .from(cm)
    .where(and(inView, eq(cm.message_type, 'cowork_user_message')));
  const [allTiers] = await client
    .select({
      total: sql<number | string>`COUNT(*)`,
      meaningful: sql<number | string>`COUNT(*) FILTER (WHERE ${pc.tier} >= 2)`,
    })
    .from(pc)
    .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
    .where(and(classifiedInWindow, viewVendor === 'all' ? undefined : messageVendor(viewVendor)));
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

  return { rows: order.map(p => rows.get(p)!), total, hasOffice, seen };
}
