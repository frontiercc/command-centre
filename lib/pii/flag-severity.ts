// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * How the Audit Log turns a message's `flag_reason` string into the severity
 * it displays, and when a flag should be shown as fully dismissed.
 *
 * CLIENT-SAFE ON PURPOSE. `app/audit/page.tsx` is a client component, so it
 * cannot import `lib/alerts/pii-alerts.ts` (which opens a database client).
 * This module has no imports at all, which is what lets the logic be unit
 * tested — it lived inline in the page before and therefore never was. That
 * is exactly how an earlier change silently downgraded a confirmed National Insurance
 * number to "low" in the compliance record: the verdict suffix broke the type
 * lookup and nothing failed.
 *
 * The severity sets below are a SECOND COPY of `severityForPiiType` in
 * `lib/alerts/pii-alerts.ts`, unavoidably, for the client-safety reason above.
 * They had already drifted once (`cpf` and `rg` were missing, so Brazilian
 * identifiers badged low). `test/audit-flag-severity.test.ts` imports both and
 * fails when they disagree, so the copy cannot drift again unnoticed.
 */

export type FlagSeverity = 'low' | 'medium' | 'high' | 'critical';

export const HIGH_SEVERITY_TYPES: ReadonlySet<string> = new Set([
  'credit_card', 'us_ssn', 'nino', 'passport', 'private_key',
  'connection_string', 'api_key', 'aws_key', 'github_token',
  'jwt_token', 'generic_secret', 'cpf',
]);

export const MEDIUM_SEVERITY_TYPES: ReadonlySet<string> = new Set([
  'iban', 'date_of_birth', 'rg',
]);

/** Drop a confirmation verdict so the bare type name can be looked up. */
function stripVerdict(type: string): string {
  return type.trim().replace(/\s*\((?:confirmed|dismissed)\)$/, '');
}

/**
 * The severity badge shown against a flagged message: the higher of the PII
 * severity (deterministic, from the pattern type) and the intent severity
 * (AI-assessed, written into the reason as a trailing parenthesis).
 */
export function flagSeverity(flagReason: string | null): FlagSeverity {
  if (!flagReason) return 'low';

  const intentMatch = flagReason.match(/Intent detected:.*\((low|medium|high|critical)\)/);
  const intentSeverity = intentMatch ? (intentMatch[1] as FlagSeverity) : null;

  const piiMatch = flagReason.match(/PII detected:\s*([^|]+)/);
  let piiSeverity: FlagSeverity | null = null;
  if (piiMatch) {
    const types = piiMatch[1].split(',').map(stripVerdict);
    if (types.some(t => HIGH_SEVERITY_TYPES.has(t))) piiSeverity = 'high';
    else if (types.some(t => MEDIUM_SEVERITY_TYPES.has(t))) piiSeverity = 'medium';
    else piiSeverity = 'low';
  }

  const order = ['low', 'medium', 'high', 'critical'] as const;
  const piiRank = piiSeverity ? order.indexOf(piiSeverity) : -1;
  const intentRank = intentSeverity ? order.indexOf(intentSeverity) : -1;
  const maxRank = Math.max(piiRank, intentRank);

  // A reason exists but matched neither shape — unknown, so not 'low'.
  if (maxRank < 0) return 'medium';
  return order[maxRank];
}

/**
 * True when every PII type on the line came back `(dismissed)` and there is no
 * intent segment — the confirmation check decided the whole flag was a shape
 * coincidence. The row is still listed and its reason still reads in full;
 * it is only de-emphasised so it stops competing with real hits.
 *
 * This deliberately does NOT change the severity value, so anything filtering
 * or sorting on severity behaves exactly as before.
 */
export function isFullyDismissed(flagReason: string | null): boolean {
  if (!flagReason) return false;
  if (/Intent detected:/.test(flagReason)) return false;
  const piiMatch = flagReason.match(/PII detected:\s*([^|]+)/);
  if (!piiMatch) return false;
  const types = piiMatch[1].split(',').map(t => t.trim()).filter(Boolean);
  if (types.length === 0) return false;
  return types.every(t => t.endsWith('(dismissed)'));
}
