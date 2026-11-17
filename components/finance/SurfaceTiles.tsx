// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The FinOps spend by surface (Chat, Code, Cowork, ChatGPT, Codex and the total), as the
// chargeback report returns it, and the words for how each figure was reached.

interface CodeTokens {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export type SurfaceBasis = 'actual' | 'estimate' | 'dormant' | 'openai_rates';

export interface SurfaceSpend {
  usd: number | null;
  tokens: CodeTokens;
  basis: SurfaceBasis;
}

export interface SurfaceSummary {
  chat: SurfaceSpend;
  code: SurfaceSpend;
  cowork: SurfaceSpend;
  chatgpt?: SurfaceSpend;
  codex?: SurfaceSpend;
  total: { usd: number; tokens: CodeTokens };
}

export const BASIS_TEXT: Record<SurfaceBasis, string> = {
  dormant: 'dormant',
  estimate: 'estimated at list rates',
  actual: 'actual, per request',
  openai_rates: "at OpenAI's USD token rates",
};
