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

/** The sum of the given products' counts. */
export function sumShown(counts: ProductCounts, shown: readonly Product[]): number {
  return shown.reduce((n, p) => n + counts[p.id], 0);
}
