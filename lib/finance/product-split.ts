// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * FinOps spend by product (Claude Code, Claude Cowork, ChatGPT, Codex), for the
 * spend trend, the month-end projection and the spend concentration card.
 * Client-safe: no server imports.
 *
 * Every split is read from the chargeback's own per-person (or per-centre)
 * figures, so the parts of a month add up to that month's FinOps headline. A
 * figure with no product breakdown (a closed month frozen before a product's
 * fields existed) counts as Claude: its undivided remainder becomes one
 * "Claude" part. Claude in Office and Google are separate estimates and never
 * enter any part.
 */
import { PRODUCT_COLOR, MODEL_OTHER } from '@/lib/ui/chart-colours';
import { computeSpendConcentration } from '@/lib/pulse/code/concentration';

export type FinopsProduct = 'claude_code' | 'claude_cowork' | 'claude' | 'chatgpt' | 'codex';
export type FinopsVendor = 'claude' | 'openai';
export type ProductParts = Partial<Record<FinopsProduct, number>>;

/** Drawing order: bottom of a stacked bar first, Claude's products before OpenAI's. */
export const FINOPS_PRODUCTS: readonly FinopsProduct[] = ['claude_code', 'claude_cowork', 'claude', 'chatgpt', 'codex'];

export const PRODUCT_VENDOR: Record<FinopsProduct, FinopsVendor> = {
  claude_code: 'claude',
  claude_cowork: 'claude',
  claude: 'claude',
  chatgpt: 'openai',
  codex: 'openai',
};

/** Full name, for tooltips. */
export const PRODUCT_NAME: Record<FinopsProduct, string> = {
  claude_code: 'Claude Code',
  claude_cowork: 'Claude Cowork',
  claude: 'Claude, not split by product',
  chatgpt: 'ChatGPT',
  codex: 'Codex',
};

/** Short name, for a legend item under its vendor's heading. */
export const PRODUCT_SHORT: Record<FinopsProduct, string> = {
  claude_code: 'Code',
  claude_cowork: 'Cowork',
  claude: 'Not split by product',
  chatgpt: 'ChatGPT',
  codex: 'Codex',
};

export const VENDOR_NAME: Record<FinopsVendor, string> = { claude: 'Claude', openai: 'OpenAI' };

/** The products' own colours (lib/ui/chart-colours.ts); undivided Claude is the neutral grey. */
export const PRODUCT_FILL: Record<FinopsProduct, string> = {
  claude_code: PRODUCT_COLOR.claude_code,
  claude_cowork: PRODUCT_COLOR.claude_cowork,
  claude: MODEL_OTHER,
  chatgpt: PRODUCT_COLOR.chatgpt_chat,
  codex: PRODUCT_COLOR.codex,
};

/** Below this, an undivided remainder is rounding, not spend. */
const REMAINDER_EPSILON = 0.005;

/** A row carrying FinOps's per-product figures (a person, a cost centre). Product fields may be absent on old snapshots. */
export interface ProductRow {
  totalUsd: number;
  codeUsd?: number;
  coworkUsd?: number;
  chatgptUsd?: number;
  codexUsd?: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Sums rows into product parts against `total` (the figure they must add up
 * to). What the product fields leave unexplained is Claude's, undivided.
 */
export function partsOfRows(rows: ProductRow[], total: number): ProductParts {
  let code = 0, cowork = 0, chatgpt = 0, codex = 0;
  for (const r of rows) {
    code += num(r.codeUsd);
    cowork += num(r.coworkUsd);
    chatgpt += num(r.chatgptUsd);
    codex += num(r.codexUsd);
  }
  const parts: ProductParts = {};
  if (code > 0) parts.claude_code = code;
  if (cowork > 0) parts.claude_cowork = cowork;
  if (chatgpt > 0) parts.chatgpt = chatgpt;
  if (codex > 0) parts.codex = codex;
  const remainder = total - (code + cowork + chatgpt + codex);
  if (remainder > REMAINDER_EPSILON) parts.claude = remainder;
  return parts;
}

/** One row's parts against its own total. */
export function partsOfRow(row: ProductRow): ProductParts {
  return partsOfRows([row], num(row.totalUsd));
}

export function partsTotal(parts: ProductParts): number {
  return FINOPS_PRODUCTS.reduce((a, p) => a + (parts[p] ?? 0), 0);
}

/** Claude's and OpenAI's share of the parts. */
export function vendorTotals(parts: ProductParts): Record<FinopsVendor, number> {
  const out: Record<FinopsVendor, number> = { claude: 0, openai: 0 };
  for (const p of FINOPS_PRODUCTS) out[PRODUCT_VENDOR[p]] += parts[p] ?? 0;
  return out;
}

/**
 * The products to draw: those with any spend in `partsList`, in drawing order.
 * On an OpenAI-only hub Claude's products are left out.
 */
export function productsPresent(partsList: ProductParts[], opts: { openaiOnly?: boolean } = {}): FinopsProduct[] {
  return FINOPS_PRODUCTS.filter(p =>
    !(opts.openaiOnly && PRODUCT_VENDOR[p] === 'claude') && partsList.some(parts => (parts[p] ?? 0) > 0));
}

/** Products grouped under their vendor's heading, for a legend. Vendors with nothing to show are left out. */
export function legendGroups(products: FinopsProduct[]): Array<{ vendor: FinopsVendor; label: string; products: FinopsProduct[] }> {
  return (['claude', 'openai'] as const)
    .map(vendor => ({ vendor, label: VENDOR_NAME[vendor], products: products.filter(p => PRODUCT_VENDOR[p] === vendor) }))
    .filter(g => g.products.length > 0);
}

export interface ProductConcentrationTier {
  topN: number;
  /** Share (0..1) of all cost-centre spend held by the top N centres. */
  share: number;
  /** That share split by product: each value is the product's spend in the top N, over all cost-centre spend. */
  parts: ProductParts;
}

/**
 * Spend concentration (lib/pulse/code/concentration.ts, unchanged rules), with
 * each tier's share split into the products of the centres it covers. Centres
 * are ranked by total, as computeSpendConcentration ranks them.
 */
export function concentrationByProduct(centres: ProductRow[]): ProductConcentrationTier[] | null {
  const base = computeSpendConcentration(centres.map(c => num(c.totalUsd)));
  if (!base) return null;
  const ranked = centres.filter(c => num(c.totalUsd) > 0).sort((a, b) => num(b.totalUsd) - num(a.totalUsd));
  return base.tiers.map(t => {
    const head = ranked.slice(0, t.topN);
    const raw = partsOfRows(head, head.reduce((a, c) => a + num(c.totalUsd), 0));
    const parts: ProductParts = {};
    for (const p of FINOPS_PRODUCTS) if (raw[p]) parts[p] = raw[p]! / base.totalSpend;
    return { topN: t.topN, share: t.share, parts };
  });
}
