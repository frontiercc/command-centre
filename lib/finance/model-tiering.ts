// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { priceTokens, normalizeModelId, type ModelRate, type ModelRates, type TokenUsage } from '@/lib/pulse/code/rates';

function rateFor(model: string, rates: ModelRates): ModelRate | undefined {
  return rates[model] ?? rates[normalizeModelId(model)];
}

/** Single scalar price used purely for tiering (input + output $/MTok). */
export function modelPrice(rate: ModelRate): number {
  return rate.in + rate.out;
}

/** Priced models only, most expensive first. Unpriced models are dropped. */
export function rankModelsByPrice(models: string[], rates: ModelRates): string[] {
  const priced = [...new Set(models)].filter((m) => rateFor(m, rates) !== undefined);
  return priced.sort((a, b) => modelPrice(rateFor(b, rates)!) - modelPrice(rateFor(a, rates)!));
}

/** The next lower-priced priced model that is actually in use, else null. */
export function nextCheaperInUse(topModel: string, modelsInUse: string[], rates: ModelRates): string | null {
  const top = rateFor(topModel, rates);
  if (!top) return null;
  const topP = modelPrice(top);
  const cheaper = rankModelsByPrice(modelsInUse, rates).filter((m) => modelPrice(rateFor(m, rates)!) < topP);
  return cheaper.length ? cheaper[0] : null;
}

/** Per-token-class reprice delta (current − target). null if unpriced or not a saving. */
export function estimateCeilingUsd(
  usage: TokenUsage,
  currentModel: string,
  targetModel: string,
  rates: ModelRates,
): number | null {
  const cur = priceTokens(currentModel, usage, rates);
  const tgt = priceTokens(targetModel, usage, rates);
  if (cur === null || tgt === null) return null;
  const delta = cur - tgt;
  return delta > 0 ? delta : null;
}
