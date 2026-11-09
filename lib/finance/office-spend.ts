// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Estimated spend for Claude in Office (Excel, Word, PowerPoint, Outlook) and
 * Claude in Google (Sheets, Docs, Slides). "Office" below covers both: they
 * send the same add-in telemetry.
 *
 * Office sends tokens but no cost (lib/otel/office-receiver.ts stores
 * cost_usd NULL), so its spend is the tokens priced from the admin model rates
 * (`priceTokens`, the same rates Developer Pulse uses). It is an ESTIMATE and
 * is never added to Cowork's reported cost, the chargeback total or a cost
 * centre. The one calculation behind every Office spend figure: the Work Pulse
 * By product panel, the FinOps Office line and the Spend Review Office line.
 *
 * A model with no rate is named in `unpricedModels` and left out, never priced
 * at zero; `usd` is null when nothing in the group could be priced.
 */
import { and, gte, isNotNull, lt, eq } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getCodeModelRates, priceTokens, type ModelRates, type TokenUsage } from '@/lib/pulse/code/rates';
import { PRODUCT_FAMILY, PRODUCT_ORDER, type WorkProduct } from '@/lib/pulse/cowork/products';

export type OfficeProduct = Exclude<WorkProduct, 'cowork'>;

export interface OfficeSpend {
  usd: number | null;
  tokens: TokenUsage;
  calls: number;
  unpricedModels: string[];
}

export interface OfficeSpendRow extends OfficeSpend {
  userId: string;
  product: OfficeProduct;
}

export interface OfficeSpendSummary {
  byProduct: Array<OfficeSpend & { product: OfficeProduct; people: number }>;
  total: OfficeSpend & { people: number };
  /** False when no Office or Google activity was found (only with allApps). */
  hasOffice: boolean;
  /** Which groups had activity: the panels say how to set up a group with none. */
  seen: { office: boolean; google: boolean };
}

const emptyTokens = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });

function asOffice(v: string | null): OfficeProduct | null {
  return v && v !== 'cowork' && (PRODUCT_ORDER as readonly string[]).includes(v) ? (v as OfficeProduct) : null;
}

/** token_usage is jsonb (read back as an object); tolerate a JSON string too. */
export function readTokenUsage(raw: unknown): TokenUsage | null {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : Number(x) || 0);
  return {
    inputTokens: n(o.inputTokens),
    outputTokens: n(o.outputTokens),
    cacheReadTokens: n(o.cacheReadTokens),
    cacheCreationTokens: n(o.cacheCreationTokens),
  };
}

/** Price one call; null when the model has no rate. */
export function priceOfficeCall(model: string | null, usage: TokenUsage | null, rates: ModelRates): number | null {
  if (!model || !usage) return null;
  return priceTokens(model, usage, rates);
}

/** Office spend per person per app over [start, end). */
export async function officeSpendByUser(start: number, end: number, userId?: string): Promise<OfficeSpendRow[]> {
  const client = await getTypedClient();
  const cm = schema.coworkMessages;
  const where = and(
    eq(cm.message_type, 'cowork_api_request'),
    isNotNull(cm.product),
    gte(cm.occurred_at, start),
    lt(cm.occurred_at, end),
    ...(userId ? [eq(cm.user_id, userId)] : []),
  );
  const calls = await client
    .select({ userId: cm.user_id, product: cm.product, model: cm.model, tokens: cm.token_usage })
    .from(cm)
    .where(where);
  const rates = await getCodeModelRates();

  const groups = new Map<string, OfficeSpendRow & { unpriced: Set<string> }>();
  for (const c of calls) {
    const product = asOffice(c.product);
    if (!product || !c.userId) continue;
    const key = `${c.userId}\u0000${product}`;
    let g = groups.get(key);
    if (!g) {
      g = { userId: c.userId, product, usd: null, tokens: emptyTokens(), calls: 0, unpricedModels: [], unpriced: new Set() };
      groups.set(key, g);
    }
    const usage = readTokenUsage(c.tokens);
    g.calls++;
    if (usage) {
      g.tokens.inputTokens += usage.inputTokens;
      g.tokens.outputTokens += usage.outputTokens;
      g.tokens.cacheReadTokens += usage.cacheReadTokens;
      g.tokens.cacheCreationTokens += usage.cacheCreationTokens;
    }
    const priced = priceOfficeCall(c.model, usage, rates);
    if (priced === null) g.unpriced.add(c.model ?? 'unknown');
    else g.usd = (g.usd ?? 0) + priced;
  }
  return [...groups.values()].map(({ unpriced, ...g }) => ({ ...g, unpricedModels: [...unpriced].sort() }));
}

function add(into: OfficeSpend, from: OfficeSpend): void {
  if (from.usd !== null) into.usd = (into.usd ?? 0) + from.usd;
  into.tokens.inputTokens += from.tokens.inputTokens;
  into.tokens.outputTokens += from.tokens.outputTokens;
  into.tokens.cacheReadTokens += from.tokens.cacheReadTokens;
  into.tokens.cacheCreationTokens += from.tokens.cacheCreationTokens;
  into.calls += from.calls;
  into.unpricedModels = [...new Set([...into.unpricedModels, ...from.unpricedModels])].sort();
}

/**
 * Roll per-person rows up by app and in total. Null when there is no Office
 * activity, unless allApps: then every app is listed (at zero when unused) and
 * hasOffice says whether any activity was found. The FinOps panel uses allApps
 * so it shows before Office monitoring is set up.
 */
export function summariseOfficeSpend(rows: OfficeSpendRow[], opts: { allApps?: boolean } = {}): OfficeSpendSummary | null {
  if (rows.length === 0 && !opts.allApps) return null;
  const byProduct = new Map<OfficeProduct, OfficeSpend & { product: OfficeProduct; people: Set<string> }>();
  const total = { usd: null as number | null, tokens: emptyTokens(), calls: 0, unpricedModels: [] as string[], people: new Set<string>() };
  for (const r of rows) {
    let p = byProduct.get(r.product);
    if (!p) { p = { product: r.product, usd: null, tokens: emptyTokens(), calls: 0, unpricedModels: [], people: new Set() }; byProduct.set(r.product, p); }
    add(p, r);
    p.people.add(r.userId);
    add(total, r);
    total.people.add(r.userId);
  }
  return {
    byProduct: PRODUCT_ORDER.filter((p): p is OfficeProduct => p !== 'cowork' && (opts.allApps || byProduct.has(p as OfficeProduct)))
      .map(p => {
        const g = byProduct.get(p) ?? { product: p, usd: null, tokens: emptyTokens(), calls: 0, unpricedModels: [], people: new Set<string>() };
        return { ...g, people: g.people.size };
      }),
    total: { ...total, people: total.people.size },
    hasOffice: rows.length > 0,
    seen: {
      office: rows.some(r => PRODUCT_FAMILY[r.product] === 'office'),
      google: rows.some(r => PRODUCT_FAMILY[r.product] === 'google'),
    },
  };
}
