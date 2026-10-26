// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Audit sampling strata + seeded PRNG. Pure/client-safe.

export type ConfidenceBand = 'lo' | 'mid' | 'hi' | 'unknown';

/**
 * Band a classifier confidence. The 0.5–0.8 band ("mid") is where errors
 * concentrate and is deliberately oversampled by the draw.
 */
export function confidenceBand(confidence: number | null | undefined): ConfidenceBand {
  if (confidence === null || confidence === undefined) return 'unknown';
  if (confidence < 0.5) return 'lo';
  if (confidence <= 0.8) return 'mid';
  return 'hi';
}

/** Stratum key `${tier}:${band}` — the unit of stratification + reweighting. */
export function computeStratum(tier: number, confidence: number | null | undefined): string {
  return `${tier}:${confidenceBand(confidence)}`;
}

/** Which bands are oversampled in the draw (hard/rare cases). */
export function isOversampledBand(band: ConfidenceBand): boolean {
  return band === 'mid';
}

/** Deterministic PRNG (mulberry32) — reproducible draws from a stored seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
