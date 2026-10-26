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
 * Map surface name to the Drizzle table that holds the message.
 * Chat messages live in chat_messages; Code and Cowork live in cowork_messages.
 */
function tableForSurface(surface: string) {
  return surface === 'chat' ? schema.chatMessages : schema.coworkMessages;
}

export async function createIntentAlerts(
  userId: string | null,
  surface: string,
  messageId: string,
  messageText: string,
  matches: IntentMatch[],
): Promise<void> {
  // Get a single AI assessment for all matches (one API call for the whole message)
  const assessment = await assessIntent(messageText, matches);

  for (const match of matches) {
    await insertAlert({
      id: uuidv4(),
      user_id: userId || 'unknown',
      alert_type: 'intent',
      severity: assessment.severity,
      title: `${match.categoryName} intent detected`,
      explanation: assessment.reasoning,
      raw_evidence: JSON.stringify({
        surface,
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
    const table = tableForSurface(surface);
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
