// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Developer Pulse — model pricing.
 *
 * Spend is computed from token counts in code_assistant_meta using $/MTok
 * rates. Defaults below are seeded from published Anthropic pricing
 * (checked against Anthropic's published prices); admins override or extend them via the
 * `code_model_rates` config key (JSON, same shape as DEFAULT_RATES).
 *
 * A model with no rate entry prices to null — NEVER silently to zero —
 * so unpriced models stay visible in the UI as "unpriced".
 */
import { getConfigValue } from '@/lib/config';
import { normalizeModelId } from '@/lib/pulse/code/model-id';

// Re-exported for existing callers (rates.ts has always been the public
// home for normalizeModelId) — the pure implementation now lives in
// model-id.ts so client components can import it without the DB layer.
export { normalizeModelId };

export interface ModelRate {
  /** USD per million input tokens */
  in: number;
  /** USD per million output tokens */
  out: number;
  /** USD per million cache-write tokens (5-min TTL ≈ 1.25× input) */
  cacheWrite: number;
  /** USD per million cache-read tokens (0.1x input; 0.025x on Fable 5.1 / Mythos 5.1) */
  cacheRead: number;
}

export type ModelRates = Record<string, ModelRate>;

function rate(inRate: number, outRate: number, cacheReadMultiplier = 0.1): ModelRate {
  return {
    in: inRate,
    out: outRate,
    cacheWrite: inRate * 1.25,
    cacheRead: inRate * cacheReadMultiplier,
  };
}

// Published Anthropic API pricing, $/MTok (input / output).
export const DEFAULT_RATES: ModelRates = {
  'claude-fable-5-1': rate(10, 50, 0.025),
  'claude-fable-5': rate(10, 50),
  'claude-opus-5': rate(5, 25),
  'claude-opus-4-8': rate(5, 25),
  'claude-opus-4-7': rate(5, 25),
  'claude-opus-4-6': rate(5, 25),
  'claude-opus-4-5': rate(5, 25),
  'claude-sonnet-5': rate(2, 10),
  'claude-sonnet-4-6': rate(3, 15),
  'claude-haiku-4-5': rate(1, 5),
  'claude-haiku-4-5-20251001': rate(1, 5),
};

/**
 * Merged rates: admin config overrides/extends the defaults.
 * Malformed config JSON falls back to defaults alone.
 */
export async function getCodeModelRates(): Promise<ModelRates> {
  const raw = await getConfigValue('codeModelRates');
  if (!raw || raw === '{}') return { ...DEFAULT_RATES };
  try {
    const parsed = JSON.parse(raw) as ModelRates;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ...DEFAULT_RATES };
    }
    return { ...DEFAULT_RATES, ...parsed };
  } catch {
    return { ...DEFAULT_RATES };
  }
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/**
 * Price a token usage for a model. Returns null when the model has no rate
 * entry — callers must surface "unpriced", not treat it as free.
 *
 * Lookup order: the exact model string first (so an admin-supplied exact
 * Bedrock/Vertex ID in `code_model_rates` with real provider pricing wins),
 * then the normalised canonical key (so undecorated Bedrock/Vertex IDs price
 * at the Anthropic list rate as an estimate).
 *
 * `rates` is now a REQUIRED argument — it used to default
 * to `getCodeModelRates()`, which is async since it reads the config table.
 * Every real caller already resolves rates once via `await getCodeModelRates()`
 * and passes them through explicitly (this stayed a pure/sync function on
 * purpose — it's called per-row in hot aggregation loops), so nothing except
 * the default itself changes; callers relying on the implicit default must
 * now pass `await getCodeModelRates()` explicitly.
 */
export function priceTokens(
  model: string,
  usage: TokenUsage,
  rates: ModelRates
): number | null {
  const r = rates[model] ?? rates[normalizeModelId(model)];
  if (!r) return null;
  const M = 1_000_000;
  return (
    (usage.inputTokens / M) * r.in +
    (usage.outputTokens / M) * r.out +
    (usage.cacheCreationTokens / M) * r.cacheWrite +
    (usage.cacheReadTokens / M) * r.cacheRead
  );
}

/**
 * True when a model prices ONLY via the normalised (Bedrock/Vertex) fallback
 * key — i.e. there is no exact rate entry, but stripping provider decoration
 * resolves to one. This is the single shared definition of "estimated
 * pricing" — reused by health.ts and the org-summary route so the rule
 * can't drift between call sites.
 */
export function isEstimatedPricing(model: string, rates: ModelRates): boolean {
  return rates[model] === undefined && rates[normalizeModelId(model)] !== undefined;
}

/**
 * True when ANY model in a priced window hit the normalised-key fallback —
 * i.e. some of the total spend is an Anthropic-list-rate estimate for a
 * Bedrock/Vertex call rather than exact provider cost. Drives the
 * `spendIsPartlyEstimated` flag on the org-summary route and its violet
 * "includes provider-routed usage estimated at list pricing" badge.
 */
export function spendIsPartlyEstimated(models: string[], rates: ModelRates): boolean {
  return models.some(m => isEstimatedPricing(m, rates));
}

/**
 * Prices a single session's per-model token breakdown — the `models_json`
 * shape `code_session_stats` stores (model -> {input, output, cache_creation,
 * cache_read}). Mirrors the aggregator's own per-session accumulation in
 * computeScopeMetrics exactly: sums only models with a rate entry, and only
 * collapses to $0 when there were genuinely no tokens at all — an unpriced
 * model with real usage stays null, never $0 (see the file header). Returns
 * the model name list alongside so a caller needing both (e.g. the audit
 * session-detail panel) parses the JSON once.
 */
export function priceModelsJson(
  modelsJson: string | null | undefined,
  rates: ModelRates
): { costUsd: number | null; models: string[] } {
  if (!modelsJson) return { costUsd: null, models: [] };
  let parsed: Record<string, { input: number; output: number; cache_creation: number; cache_read: number }>;
  try {
    parsed = JSON.parse(modelsJson);
  } catch {
    return { costUsd: null, models: [] };
  }
  const models = Object.keys(parsed);
  let spend = 0;
  let totalTokens = 0;
  let anyPriced = false;
  for (const [model, u] of Object.entries(parsed)) {
    totalTokens += (u.input || 0) + (u.output || 0) + (u.cache_creation || 0) + (u.cache_read || 0);
    const usd = priceTokens(model, {
      inputTokens: u.input || 0,
      outputTokens: u.output || 0,
      cacheCreationTokens: u.cache_creation || 0,
      cacheReadTokens: u.cache_read || 0,
    }, rates);
    if (usd !== null) { spend += usd; anyPriced = true; }
  }
  return { costUsd: anyPriced ? spend : (totalTokens > 0 ? null : 0), models };
}
