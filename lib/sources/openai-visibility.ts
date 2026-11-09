// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// "Show ChatGPT and Codex" (the OpenAI panel, beside the key). Off hides
// OpenAI's products from the analytics screens only: the dashboard, Work Pulse,
// Developer Pulse, FinOps, Spend Review, the Board, use cases, reports and
// briefings then read as a Claude-only hub. Collection carries on underneath,
// so switching it back on shows everything with no gap, and the Audit Log (the
// compliance record) always lists ChatGPT and Codex prompts.
//
// Server side only. Pages read the same switch through useConnectedProducts,
// whose `openai` is false while hidden (`openaiConnected` stays the raw fact).
import { getConfigValue } from '@/lib/config';
import { parseVendor, type Vendor } from '@/lib/dashboard/vendor';

/** True unless an admin switched "Show ChatGPT and Codex" off. */
export async function openaiShown(): Promise<boolean> {
  return (await getConfigValue('openaiShown')) !== 'false';
}

/**
 * The vendor a route should read: the requested one, or Claude's whenever
 * ChatGPT and Codex are hidden, so the All figures cover Claude alone.
 */
export async function visibleVendor(param: string | null | undefined): Promise<Vendor> {
  const vendor = parseVendor(param);
  return (await openaiShown()) ? vendor : 'claude';
}

/** `present`, unless ChatGPT and Codex are hidden. For "is there OpenAI data to show" checks. */
export async function visibleOpenAi(present: boolean | Promise<boolean>): Promise<boolean> {
  return (await present) && (await openaiShown());
}
