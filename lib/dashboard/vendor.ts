// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The dashboard's vendor switch (All / Claude / OpenAI) and the three kinds of
// work its boxes and charts show. Client-safe: no server imports.
//
// Every prompt lives in cowork_messages; the kind of work comes from its
// surface and source, the vendor from its source:
//   Chat  Claude Chat (surface 'chat') and ChatGPT Chat (source 'chatgpt_chat')
//   Work  Claude Cowork and ChatGPT Work (surface 'cowork')
//   Code  Claude Code and Codex (surface 'code')

export const VENDORS = ['all', 'claude', 'openai'] as const;
export type Vendor = (typeof VENDORS)[number];

export const VENDOR_LABELS: Record<Vendor, string> = {
  all: 'All',
  claude: 'Claude',
  openai: 'OpenAI',
};

/**
 * Work Pulse's labels for the same switch. Codex is not in Work Pulse, so on
 * its pages OpenAI only ever means ChatGPT and the switch says so.
 */
export const WORK_PULSE_VENDOR_LABELS: Record<Vendor, string> = {
  all: 'All',
  claude: 'Claude',
  openai: 'ChatGPT',
};

/**
 * Developer Pulse's labels for the same switch. Codex is its only OpenAI
 * product, so on its pages the OpenAI view is named Codex.
 */
export const DEVELOPER_PULSE_VENDOR_LABELS: Record<Vendor, string> = {
  all: 'All',
  claude: 'Claude',
  openai: 'Codex',
};

export type WorkKind = 'chat' | 'work' | 'code';

export function parseVendor(v: string | null | undefined): Vendor {
  return (VENDORS as readonly string[]).includes(v ?? '') ? (v as Vendor) : 'all';
}

/** One figure for each vendor; `total` is the figure the box shows. */
export interface VendorSplit {
  total: number;
  claude: number;
  openai: number;
}

/** The six products the dashboard splits its charts into, in display order. */
export const PRODUCTS = [
  { id: 'claude_chat', label: 'Claude Chat', kind: 'chat', vendor: 'claude' },
  { id: 'chatgpt_chat', label: 'ChatGPT Chat', kind: 'chat', vendor: 'openai' },
  { id: 'claude_cowork', label: 'Claude Cowork', kind: 'work', vendor: 'claude' },
  { id: 'chatgpt_work', label: 'ChatGPT Work', kind: 'work', vendor: 'openai' },
  { id: 'claude_code', label: 'Claude Code', kind: 'code', vendor: 'claude' },
  { id: 'codex', label: 'Codex', kind: 'code', vendor: 'openai' },
] as const;

export type Product = (typeof PRODUCTS)[number];
export type ProductId = Product['id'];
export type ProductCounts = Record<ProductId, number>;

export const PRODUCT_IDS = PRODUCTS.map((p) => p.id) as ProductId[];

export function isProductId(v: string | null | undefined): v is ProductId {
  return !!v && (PRODUCT_IDS as string[]).includes(v);
}

export function productLabel(id: ProductId): string {
  return PRODUCTS.find((p) => p.id === id)!.label;
}

/**
 * The product a row came from, from its surface and source: the same rule as
 * productExpr in lib/dashboard/product-sql.ts.
 */
export function productOf(surface: string | null | undefined, source: string | null | undefined): ProductId {
  if (source === 'chatgpt_chat' || source === 'chatgpt_work' || source === 'codex') return source;
  if (surface === 'chat') return 'claude_chat';
  if (surface === 'code') return 'claude_code';
  return 'claude_cowork';
}

export function zeroCounts(): ProductCounts {
  return { claude_chat: 0, chatgpt_chat: 0, claude_cowork: 0, chatgpt_work: 0, claude_code: 0, codex: 0 };
}

/**
 * The products a view shows: the chosen vendor's three, or all six in the
 * All view once OpenAI data exists (Claude's three before then).
 */
export function productsShown(vendor: Vendor, openaiPresent: boolean): Product[] {
  if (vendor === 'all') return openaiPresent ? [...PRODUCTS] : PRODUCTS.filter((p) => p.vendor === 'claude');
  return PRODUCTS.filter((p) => p.vendor === vendor);
}

/**
 * The dashboard's name for each product. Claude Cowork's figures include
 * Claude in Office and Google (stored beside Cowork), so while those are shown
 * (Admin → Work Pulse) the dashboard calls it "Claude Cowork and apps".
 * Everywhere else, such as an Audit Log row, it stays "Claude Cowork".
 */
export function dashboardProducts<P extends Product>(products: readonly P[], officeShown: boolean): P[] {
  return products.map(p => (p.id === 'claude_cowork' && officeShown ? { ...p, label: 'Claude Cowork and apps' } : p));
}

/** The sum of the given products' counts. */
export function sumShown(counts: ProductCounts, shown: readonly Product[]): number {
  return shown.reduce((n, p) => n + counts[p.id], 0);
}
