// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// The one rule for valuing a ChatGPT hourly cost record (OpenAI's COSTS log),
// used by Work Pulse, FinOps and Spend Review alike. Pure and client-safe.
//
// A record normally splits its tokens into input, cached input and output, and
// is priced from them at the rates table, like every other surface. On some
// plans OpenAI sends only totals (`text_total_tokens` and the like), which
// cannot be split, so the split counts arrive as zero. Pricing those zeros
// would count the record as $0 without saying so. Such a record is valued at
// the dollar figure OpenAI reports in the same record instead: its USD charge,
// or its estimate for a charge in credits. When OpenAI gives no dollar figure
// either, the value is unknown (null), never zero, and the model is named as
// unpriced.
import { priceTokens, type ModelRates, type TokenUsage } from '@/lib/pulse/code/rates';

/** True when a record carries no split token counts, so it is valued at OpenAI's figure. */
export function hasNoTokenSplit(usage: TokenUsage): boolean {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens === 0;
}

/** A ChatGPT cost record's dollar value, or null when it cannot be valued. */
export function valueChatgptCost(model: string | null, usage: TokenUsage, reportedUsd: number | null, rates: ModelRates): number | null {
  if (hasNoTokenSplit(usage)) return reportedUsd;
  return model === null ? null : priceTokens(model, usage, rates);
}
