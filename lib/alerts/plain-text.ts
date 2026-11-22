// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Plain wording for the alert text written by code (not the AI-written
// explanations). Client-safe: the Alerts page also uses it to show alerts
// stored before the wording changed.

/** "API key detected" -> "API key found in a prompt. Flagged automatically." */
export function piiAlertExplanation(title: string, via?: string): string {
  const what = title.replace(/ detected$/, '').replace(/^PII detected: (.+)$/, 'Personal data ($1)');
  const where = via && via !== 'OTel' ? `in a prompt via ${via}` : 'in a prompt';
  return `${what} found ${where}. Flagged automatically.`;
}

/** Sentence case for a category name: "Destructive Action" -> "Destructive action"; "Shadow IT" stays. */
export function sentenceCaseName(name: string): string {
  return name
    .split(' ')
    .map((w, i) => (i > 0 && /^[A-Z][a-z]+$/.test(w) ? w.toLowerCase() : w))
    .join(' ');
}

/**
 * The same wording for alerts stored before it changed: the old personal-data
 * explanation template and Title Case intent categories in alert titles.
 * Anything else is returned unchanged.
 */
export function plainStoredAlertText(text: string): string {
  const pii = text.match(/^(.+ detected|PII detected: .+?) (?:via (.+?)|in .+? surface)\. Flagged automatically by PII pattern detection\.$/);
  if (pii) return piiAlertExplanation(pii[1], pii[2]);
  const intent = text.match(/^(.+) intent detected( in .+)?$/);
  if (intent) return `${sentenceCaseName(intent[1])} intent detected${intent[2] ?? ''}`;
  return text;
}
