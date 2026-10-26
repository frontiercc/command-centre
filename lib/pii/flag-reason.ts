// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Annotating the PII portion of a message's flag_reason with confirmation
 * verdicts, without disturbing anything else on the line.
 *
 * flag_reason has TWO asynchronous writers. lib/alerts/intent-alerts.ts:71
 * appends ` | Intent detected: …` when it sees a `PII detected:%` prefix; this
 * rewrites the `PII detected: …` segment in place. Either can land first, so
 * each must preserve the other's work. This function is the PII half.
 *
 * Format written at ingest (lib/otel/*-receiver.ts):
 *   "PII detected: nino, credit_card"
 * After intent enrichment:
 *   "PII detected: nino, credit_card | Intent detected: data_exfiltration (high)"
 * After this:
 *   "PII detected: nino (dismissed), credit_card | Intent detected: …"
 *
 * Pure — the read-modify-write around it lives in lib/alerts/pii-alerts.ts.
 */
import type { PiiVerdict } from './confirm';

const PII_PREFIX = 'PII detected: ';
const SEGMENT_SEPARATOR = ' | ';

export function applyPiiVerdicts(
  existing: string | null,
  verdicts: ReadonlyMap<string, PiiVerdict>,
): string | null {
  if (!existing) return existing;
  if (verdicts.size === 0) return existing;

  const segments = existing.split(SEGMENT_SEPARATOR);

  // Only a segment that STARTS with the prefix is the PII segment. A later
  // segment that merely contains the words is someone else's text.
  const idx = segments.findIndex(s => s.startsWith(PII_PREFIX));
  if (idx === -1) return existing;

  const types = segments[idx].slice(PII_PREFIX.length).split(',').map(t => t.trim()).filter(Boolean);

  const annotated = types.map(entry => {
    // Already carries a verdict — leave it, so a re-run cannot double-annotate.
    if (entry.endsWith(')')) return entry;
    const verdict = verdicts.get(entry);
    return verdict ? `${entry} (${verdict})` : entry;
  });

  segments[idx] = PII_PREFIX + annotated.join(', ');
  return segments.join(SEGMENT_SEPARATOR);
}
