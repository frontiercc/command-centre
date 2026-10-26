// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic intent pattern matching — Layer 2 of the detection pipeline.
 *
 * Scans text for phrases that indicate risky behavioural intent.
 * Case-insensitive substring matching against category phrase libraries.
 * Zero API cost — runs on every message at ingest time.
 */
import type { IntentCategory, IntentMatch } from './types';
import { BUILT_IN_CATEGORIES } from './categories';

/**
 * Normalise text for substring matching: lowercase, then NFD-decompose and
 * strip combining marks, so "não"/"nao" and "exportação"/"exportacao" compare
 * equal. Applied to BOTH the message text and every phrase — English matching
 * is unaffected (ASCII has no combining marks).
 */
export function normaliseForMatch(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Detect intent patterns in text.
 *
 * @param text - The message text to scan
 * @param customCategories - Optional saved categories (from admin config): the
 *   organisation's own categories plus, flagged `builtIn`, the on/off state of
 *   any built-in category switched on the Intent Detection page
 * @returns Array of IntentMatch objects, one per matched category
 */
export function detectIntent(
  text: string,
  customCategories?: IntentCategory[],
): IntentMatch[] {
  if (!text || !text.trim()) return [];

  const lower = normaliseForMatch(text);
  // A built-in category switched on or off is saved as a copy flagged builtIn.
  // Only its on/off state applies; phrases always come from the built-in list.
  // (The same rule as GET /api/intent-categories, which shows the switches.)
  const saved = customCategories || [];
  const builtInEnabled = new Map(saved.filter(c => c.builtIn).map(c => [c.id, c.enabled]));
  const builtIns = BUILT_IN_CATEGORIES.map(c =>
    builtInEnabled.has(c.id) ? { ...c, enabled: builtInEnabled.get(c.id)! } : c,
  );
  const allCategories = [...builtIns, ...saved.filter(c => !c.builtIn)];
  const matches: IntentMatch[] = [];

  for (const category of allCategories) {
    if (!category.enabled) continue;

    const matchedPhrases: string[] = [];
    for (const phrase of category.phrases) {
      if (lower.includes(normaliseForMatch(phrase))) {
        matchedPhrases.push(phrase);
      }
    }

    if (matchedPhrases.length > 0) {
      matches.push({
        categoryId: category.id,
        categoryName: category.name,
        matchedPhrases,
        defaultSeverity: category.defaultSeverity,
      });
    }
  }

  return matches;
}
