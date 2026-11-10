// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Alert creation for behavioural intent detection.
 *
 * Creates alerts with type 'intent' (distinct from 'policy' PII alerts).
 * Calls Haiku for contextual severity assessment before creating the alert.
 * One alert per matched intent category.
 *
 * After assessment, enriches the source message's flag_reason with the
 * AI-assessed severity so the audit log shows severity in one view.
 */
import { v4 as uuidv4 } from 'uuid';
import { eq, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { insertAlert } from '@/lib/db/queries';
import { assessIntent } from '@/lib/intent/assess';
import type { IntentMatch } from '@/lib/intent/types';


/**
 * The product a prompt was typed in, for an intent alert whose caller named
 * none: the Claude product its surface belongs to. The OpenAI sync and the
 * Office receiver always name theirs (ChatGPT Chat, ChatGPT Work, Codex,
 * Claude in Excel...), so this only covers the Claude Cowork, Code and Chat
 * paths.
 */
export function intentProductLabel(surface: string, product?: string | null): string {
  if (product) return product;
  if (surface === 'code') return 'Claude Code';
  if (surface === 'chat') return 'Claude Chat';
  return 'Claude Cowork';
}

export async function createIntentAlerts(
  userId: string | null,
  surface: string,
  messageId: string,
  messageText: string,
  matches: IntentMatch[],
  /** The product the prompt was typed in; defaults to the Claude product of its surface. */
  product?: string | null,
): Promise<void> {
  // Get a single AI assessment for all matches (one API call for the whole message)
  const assessment = await assessIntent(messageText, matches);
  const productLabel = intentProductLabel(surface, product);

  for (const match of matches) {
    await insertAlert({
      id: uuidv4(),
      user_id: userId || 'unknown',
      alert_type: 'intent',
      severity: assessment.severity,
      // The product is in the title, not only the explanation: the
      // explanation is the AI reasoning, which viewers outside the Audit Log
      // rule do not see (lib/alerts/evidence-visibility.ts).
      title: `${match.categoryName} intent detected in ${productLabel}`,
      explanation: assessment.reasoning,
      raw_evidence: JSON.stringify({
        surface,
        product: productLabel,
        message_id: messageId,
        intent_category: match.categoryId,
        matched_patterns: match.matchedPhrases,
        ai_assessment: {
          severity: assessment.severity,
          reasoning: assessment.reasoning,
          recommended_action: assessment.recommendedAction,
        },
      }),
    });
  }

  // Enrich the source message's flag_reason with AI-assessed severity
  // so the audit log shows severity without jumping to the alerts page
  try {
    // Every prompt, Claude Chat included (surface 'chat'), lives in cowork_messages.
    const table = schema.coworkMessages;
    const categories = matches.map(m => m.categoryId).join(', ');
    const enrichedReason = `Intent detected: ${categories} (${assessment.severity})`;

    const client = await getTypedClient();
    await client
      .update(table)
      .set({
        flag_reason: sql`CASE WHEN ${table.flag_reason} LIKE 'PII detected:%' THEN ${table.flag_reason} || ' | ' || ${enrichedReason} ELSE ${enrichedReason} END`,
      })
      .where(eq(table.id, messageId));
  } catch { /* enrichment failure must not break alert creation */ }
}
