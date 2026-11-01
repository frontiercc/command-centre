// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The spend figure on Work Pulse pages (Executive View, department, My Pulse),
// by the Claude / ChatGPT switch. One rule, so the three pages agree.
// Client-safe: no server imports.
//
// Claude Cowork's spend comes from its telemetry; ChatGPT's from OpenAI's cost
// records (lib/openai/spend.ts). Claude Chat carries no spend. Each part keeps
// its own label: the All view shows the total with both parts beneath it.
import type { Vendor } from '@/lib/dashboard/vendor';

export interface SpendFigure {
  /** 'Spend', 'Claude Cowork spend' or 'ChatGPT spend'; pages add their own scope. */
  label: string;
  /** Null: not recorded. */
  usd: number | null;
  sub: string;
  /** True when ChatGPT has usage but none of its models has a rate: show "Not priced", never $0. */
  notPriced?: boolean;
}

export function formatUsd(usd: number): string {
  if (usd === 0) return '$0.00';
  return usd >= 100 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2)}`;
}

const CHATGPT_NOTE = "ChatGPT is priced from its tokens at OpenAI's USD (token-based) contract rates, a few hours behind.";

function unpricedNote(n: number): string {
  return n > 0 ? ` ${n} ChatGPT model${n === 1 ? ' has' : 's have'} no rate yet and ${n === 1 ? 'is' : 'are'} not included: see Admin → Developer Pulse → Rates.` : '';
}

/**
 * `cowork` is undefined in the ChatGPT view; `chatgpt` is undefined in the
 * Claude view and on a hub with no OpenAI data, and null when OpenAI data
 * exists but no cost record has arrived.
 */
export function workSpendFigure(
  vendor: Vendor,
  cowork: number | undefined,
  chatgpt: number | null | undefined,
  /** ChatGPT models seen with no rate, left out of the ChatGPT figure. */
  chatgptUnpriced = 0,
): SpendFigure | null {
  // Usage seen, but no ChatGPT model priced: never shown as $0.
  const chatgptNotPriced = chatgpt === 0 && chatgptUnpriced > 0;
  if (vendor === 'openai') {
    if (chatgpt === undefined) return null;
    return { label: 'ChatGPT spend', usd: chatgpt, notPriced: chatgptNotPriced, sub: `ChatGPT Chat and ChatGPT Work. ${CHATGPT_NOTE}${unpricedNote(chatgptUnpriced)}` };
  }
  if (cowork === undefined) return null;
  if (vendor === 'all' && typeof chatgpt === 'number') {
    return {
      label: 'Spend',
      usd: cowork + chatgpt,
      // Nothing priced at all: not a $0 total.
      notPriced: chatgptNotPriced && cowork === 0,
      sub: `Claude Cowork ${formatUsd(cowork)} · ChatGPT ${chatgptNotPriced ? 'not priced' : formatUsd(chatgpt)}. ${CHATGPT_NOTE}${unpricedNote(chatgptUnpriced)}`,
    };
  }
  return {
    label: 'Claude Cowork spend',
    usd: cowork,
    sub: chatgpt === null
      ? 'API cost of every Claude Cowork session, measured. No ChatGPT cost record has arrived yet.'
      : 'API cost of every Claude Cowork session, measured.',
  };
}
