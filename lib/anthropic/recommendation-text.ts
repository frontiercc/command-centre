// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Keeps a dashboard recommendation short: long text crowded the boxes.
 * The prompt asks for two short sentences; this is the guarantee. It only ever removes text,
 * never rewrites it, so the numbers it keeps have already passed the grounding check.
 * Pure, client-safe.
 */

/** Two sentences at most; one if the two run past MAX_WORDS. Dashes become commas. */
export const MAX_WORDS = 40;

// Abbreviations whose full stop does not end a sentence.
const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|approx|incl|cf|eg|ie)\.$/i;

/** Split prose into sentences at . ! or ? followed by a space, keeping decimals ($0.13) and
 *  abbreviations ("e.g.", "etc.") inside their sentence. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/(?<=[.!?])\s+/)) {
    const piece = part.trim();
    if (!piece) continue;
    if (out.length > 0 && ABBREVIATION.test(out[out.length - 1])) out[out.length - 1] += ' ' + piece;
    else out.push(piece);
  }
  return out;
}

export function tightenRecommendation(detail: string): string {
  const text = detail.replace(/\s*[—–]\s*/g, ', ').replace(/\s+/g, ' ').trim();
  const sentences = splitSentences(text);
  const two = sentences.slice(0, 2).join(' ');
  const words = two.split(' ').length;
  return words > MAX_WORDS && sentences.length > 1 ? sentences[0] : two;
}
