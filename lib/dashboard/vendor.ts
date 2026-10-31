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
