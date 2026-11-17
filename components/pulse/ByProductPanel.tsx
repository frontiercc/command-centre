// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Work Pulse "By product" (Claude Chat, Cowork, the Claude in Office and Google apps, ChatGPT),
// as GET /api/pulse/org-summary returns it in byProduct (lib/pulse/cowork/by-product.ts).
import type { WorkProduct } from '@/lib/pulse/cowork/products';

/** A panel row: Claude Chat, Cowork, an Office or Google app, or ChatGPT. */
export type PanelProduct = 'claude_chat' | WorkProduct | 'chatgpt';

export interface ByProductRow {
  product: PanelProduct | 'all';
  people: number;
  sessions: number;
  meaningfulPct: number | null;
  producedPct: number | null;
  spendUsd: number | null;
  spendEstimated: boolean;
  unpricedModels: string[];
}

export interface ByProductData {
  rows: ByProductRow[];
  total: ByProductRow;
  hasOffice: boolean;
  /** Which groups had activity. Absent from an older response: read as both seen. */
  seen?: { office: boolean; google: boolean };
}
