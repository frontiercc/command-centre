// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Alert evidence can carry a quote of the person's prompt (a personal-data
// alert keeps the first 200 characters of the message beside the masked
// value). The Alerts page is open to viewers, so that quote follows the Audit
// Log rule, as the Pulse snippets do (lib/auth/content-access.ts): admins see
// it for everyone, a manager for their own department (everyone when they
// have none), nobody else. Everything else on the alert, the masked value
// included, is unchanged.
//
// An intent alert carries the AI's reasoning instead, as its explanation and
// in raw_evidence.ai_assessment. The assessor is asked to keep quotes
// verbatim, so that reasoning can quote or retell what the person typed; it
// follows the same rule (security re-review R4).
import type { NextRequest } from 'next/server';
import { canAccessAuditLog, type AdminSessionResult } from '@/lib/auth/admin-auth';
import { promptTextVisibleFor, logPromptRead } from '@/lib/auth/content-access';

/** Evidence keys that hold a person's prompt text, or AI reasoning about it. */
const PROMPT_TEXT_KEYS = ['evidence', 'ai_assessment'];

/** What a caller outside the rule sees in place of an intent alert's reasoning. */
export const WITHHELD_REASONING =
  "The AI assessment is hidden: it can quote what the person typed, which only admins and their department's managers may read.";

function parseEvidence(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function hasPromptEvidence(raw: string | null): boolean {
  const ev = parseEvidence(raw);
  return !!ev && PROMPT_TEXT_KEYS.some(k => k in ev);
}

/** The evidence JSON without its prompt-text keys; other values untouched. */
export function stripPromptEvidence(raw: string | null): string | null {
  const ev = parseEvidence(raw);
  if (!ev || !PROMPT_TEXT_KEYS.some(k => k in ev)) return raw;
  const kept = Object.fromEntries(Object.entries(ev).filter(([k]) => !PROMPT_TEXT_KEYS.includes(k)));
  return JSON.stringify(kept);
}

type AlertLike = { user_id: string | null; raw_evidence: string | null; alert_type?: string | null; explanation?: string | null };

/**
 * Removes the prompt quote from alerts whose person the caller may not read,
 * and access-logs the read when any quote is returned.
 */
export async function applyAlertEvidenceRule<T extends AlertLike>(
  request: NextRequest,
  session: AdminSessionResult,
  alerts: T[],
): Promise<T[]> {
  const withText = alerts.filter(a => hasPromptEvidence(a.raw_evidence));
  if (withText.length === 0) return alerts;

  const visible = await promptTextVisibleFor(session, withText.map(a => a.user_id));
  // An alert with no person attached is readable only by a caller with no
  // department restriction (an admin, or a manager with no department).
  const unrestricted = session.authenticated && canAccessAuditLog(session.role)
    && (session.role === 'admin' || !session.department);

  let shown = false;
  const out = alerts.map(a => {
    if (!hasPromptEvidence(a.raw_evidence)) return a;
    const allowed = a.user_id ? visible.has(a.user_id) : unrestricted;
    if (allowed) { shown = true; return a; }
    const stripped = { ...a, raw_evidence: stripPromptEvidence(a.raw_evidence) };
    return a.alert_type === 'intent' && 'explanation' in a
      ? { ...stripped, explanation: WITHHELD_REASONING }
      : stripped;
  });
  if (shown) await logPromptRead(request, session, 'alerts/evidence');
  return out;
}
