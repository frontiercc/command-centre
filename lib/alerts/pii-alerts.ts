// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic alert creation for PII/credential flags.
 *
 * Every flagged message creates an alert immediately at ingest time.
 * Severity is mapped from the PII pattern type — no AI judgement involved.
 */
import { v4 as uuidv4 } from 'uuid';
import { and, eq, gte, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { insertAlert } from '@/lib/db/queries';
import { detectPiiWithMatches, type PiiMatch } from '@/lib/pii/detect';
import { needsConfirmation } from '@/lib/pii/confirm-scope';
import { confirmPiiMatch, type PiiVerdict } from '@/lib/pii/confirm';
import { applyPiiVerdicts } from '@/lib/pii/flag-reason';

// ── Severity mapping: PII type → alert severity ──────────────────────────

const HIGH_SEVERITY_TYPES = new Set([
  'credit_card', 'us_ssn', 'nino', 'passport', 'private_key',
  'connection_string', 'api_key', 'aws_key', 'github_token',
  'jwt_token', 'generic_secret',
  'cpf',
]);

const MEDIUM_SEVERITY_TYPES = new Set([
  'iban', 'date_of_birth',
  'rg',
]);

// Everything else (email, uk_phone, us_phone, br_phone, ip_address) → low

export function severityForPiiType(piiType: string): 'low' | 'medium' | 'high' {
  if (HIGH_SEVERITY_TYPES.has(piiType)) return 'high';
  if (MEDIUM_SEVERITY_TYPES.has(piiType)) return 'medium';
  return 'low';
}

// ── Titles by PII type ───────────────────────────────────────────────────

export const TITLES: Record<string, string> = {
  credit_card: 'Credit card number detected',
  us_ssn: 'US Social Security number detected',
  nino: 'UK National Insurance number detected',
  passport: 'Passport number detected',
  private_key: 'Private key detected',
  connection_string: 'Database connection string detected',
  api_key: 'API key detected',
  aws_key: 'AWS access key detected',
  github_token: 'GitHub token detected',
  jwt_token: 'JWT token detected',
  generic_secret: 'Secret or credential detected',
  iban: 'IBAN detected',
  date_of_birth: 'Date of birth detected',
  email: 'Email address detected',
  uk_phone: 'UK phone number detected',
  us_phone: 'US phone number detected',
  ip_address: 'IP address detected',
  cpf: 'Brazilian CPF detected',
  rg: 'Brazilian RG (state ID) detected',
  br_phone: 'Brazilian phone number detected',
};

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Create PII alerts with 24h dedup via ->> on raw_evidence.
 * Used by OTel receiver to handle at-least-once delivery semantics.
 *
 * For each match, checks if an alert with the same pii_type was created
 * in the last 24h. If yes, skips it (dedup). If no, creates a new alert
 * with verifiable evidence: the masked matched value plus surface +
 * message_id, so an alert can be traced back to the exact message rather
 * than just an arbitrary 200-char prefix of the source text.
 *
 * CRITICAL: exact-match on pii_type — raw_evidence ->> 'pii_type' = ? (the
 * same expression getSecurityMetrics uses in lib/db/queries.ts) — NOT a LIKE
 * substring match, which would match e.g. 'ssn' inside 'us_ssn' and break dedup.
 */
export async function createPiiAlertsWithDedup(
  userId: string,
  piiMatches: PiiMatch[],
  evidence: string,
  messageId: string,
  surface: string,
): Promise<void> {
  const client = await getTypedClient();
  const a = schema.alerts;
  const piiTypeExpr = sql`raw_evidence ->> 'pii_type'`;
  const cutoff = Math.floor(Date.now() / 1000) - 86400; // 24h window (app clock)

  // Collected across the loop; written once at the end.
  const verdicts = new Map<string, PiiVerdict>();
  const reasons: string[] = [];

  for (const { type: piiType, masked } of piiMatches) {
    const recentRows = await client
      .select({ one: sql<number>`1` })
      .from(a)
      .where(and(
        eq(a.user_id, userId),
        eq(a.alert_type, 'policy'),
        sql`${piiTypeExpr} = ${piiType}`,
        gte(a.generated_at, cutoff),
      ))
      .limit(1);

    // If no recent alert found, create a new one
    if (recentRows.length === 0) {
      // Shape-only patterns get a judgement call before the alert fires. A
      // deduped match never reaches here, so it never spends a call.
      // HARD RULE: only an explicit 'dismissed' suppresses. confirmPiiMatch
      // already swallows its own failures, and this catch is the second net.
      if (needsConfirmation(piiType)) {
        let verdict: PiiVerdict = 'confirmed';
        let reason: string | null = null;
        try {
          const r = await confirmPiiMatch(evidence, piiType, masked);
          verdict = r.verdict;
          reason = r.reason;
        } catch {
          verdict = 'confirmed';
        }
        verdicts.set(piiType, verdict);
        // The justification, kept so the Audit Log can say WHY a match was
        // set aside rather than only that it was. Prefixed with the type so
        // a message carrying several checked types stays readable.
        if (reason) reasons.push(`${piiType}: ${reason}`);
        if (verdict === 'dismissed') continue; // no alert, no Slack
      }

      const severity = severityForPiiType(piiType);
      const title = TITLES[piiType] || `PII detected: ${piiType}`;

      await insertAlert({
        id: uuidv4(),
        user_id: userId,
        alert_type: 'policy',
        severity,
        title,
        explanation: `${title} detected via OTel. Flagged automatically by PII pattern detection.`,
        raw_evidence: JSON.stringify({
          surface,
          message_id: messageId,
          pii_type: piiType,
          masked_value: masked,
          evidence: evidence.slice(0, 200),
        }),
      });
    }
  }

  // One read-modify-write for the whole message — but a DIFFERENT fire-and-
  // forget writer (lib/alerts/intent-alerts.ts) updates this same column on
  // this same message, appending its own ` | Intent detected: …` segment.
  // Both sit behind their own Claude call and both fire on exactly the
  // messages where both a PII pattern and an intent phrase matched, so a
  // plain read-then-write here could land between intent-alerts' read and
  // write and silently overwrite its segment. The write below is a
  // compare-and-swap instead: the WHERE pins flag_reason to what we just
  // read, and an empty `.returning()` means someone else wrote first — the
  // same empty-array-as-rejection signal the TOTP replay guard uses
  // (lib/auth/totp.ts). One retry (re-read, re-apply, re-write), then give
  // up silently — never loop. Best-effort throughout: a failure here must
  // never undo an alert that was correctly raised.
  if (verdicts.size > 0) {
    try {
      const table = surface === 'chat' ? schema.chatMessages : schema.coworkMessages;

      const attemptWrite = async (): Promise<boolean> => {
        const rows = await client
          .select({ flag_reason: table.flag_reason })
          .from(table)
          .where(eq(table.id, messageId))
          .limit(1);
        const existing = rows[0]?.flag_reason ?? null;
        const next = applyPiiVerdicts(existing, verdicts);
        // existing is never null on the write path below: applyPiiVerdicts
        // returns null unchanged for a null/empty input, which the
        // `next === existing` check also catches (nothing to write either
        // way) — so eq(table.flag_reason, existing) never has to compare
        // against null, which is not valid SQL equality.
        if (existing === null || next === null || next === existing) return true;
        // chat_messages has no pii_verdict_reason column — the Compliance
        // path does not run the confirmation check, so the reason is written
        // only on the cowork/code table.
        const patch: Record<string, unknown> = { flag_reason: next };
        if (reasons.length > 0 && table === schema.coworkMessages) {
          patch.pii_verdict_reason = reasons.join(' | ').slice(0, 1000);
        }
        const result = await client
          .update(table)
          .set(patch)
          .where(and(eq(table.id, messageId), eq(table.flag_reason, existing)))
          .returning({ id: table.id });
        return result.length > 0;
      };

      if (!(await attemptWrite())) {
        await attemptWrite();
      }
    } catch { /* annotation failure must not break alert creation */ }
  }
}

/**
 * Create alerts for PII regex flags.
 * Runs detection with masking to include masked values in alert evidence.
 * One alert per PII type found.
 */
export async function createPiiAlerts(
  userId: string | null,
  flagReason: string,
  surface: string,
  messageId: string,
  sourceText?: string,
): Promise<void> {
  // If source text provided, run detection with masking for richer alerts
  if (sourceText) {
    const piiMatches = detectPiiWithMatches(sourceText);
    for (const { type: piiType, masked } of piiMatches) {
      const severity = severityForPiiType(piiType);
      const title = TITLES[piiType] || `PII detected: ${piiType}`;

      await insertAlert({
        id: uuidv4(),
        user_id: userId || 'unknown',
        alert_type: 'policy',
        severity,
        title,
        explanation: `${title} in ${surface} surface. Flagged automatically by PII pattern detection.`,
        raw_evidence: JSON.stringify({ surface, message_id: messageId, pii_type: piiType, masked_value: masked }),
      });
    }
    return;
  }

  // Fallback: parse PII types from flag_reason string (no masked values)
  const match = flagReason.match(/^PII detected:\s*(.+)$/);
  if (!match) return;

  const piiTypes = match[1].split(',').map(t => t.trim()).filter(Boolean);

  for (const piiType of piiTypes) {
    const severity = severityForPiiType(piiType);
    const title = TITLES[piiType] || `PII detected: ${piiType}`;

    await insertAlert({
      id: uuidv4(),
      user_id: userId || 'unknown',
      alert_type: 'policy',
      severity,
      title,
      explanation: `${title} in ${surface} surface. Flagged automatically by PII pattern detection.`,
      raw_evidence: JSON.stringify({ surface, message_id: messageId, pii_type: piiType }),
    });
  }
}
