// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * AI-powered intent severity assessment — Layer 3 of the detection pipeline.
 *
 * Only called for messages that triggered intent pattern matches (Layer 2).
 * Uses Haiku for cost-efficient contextual severity assessment.
 * ~$0.001 per call, only on pre-filtered messages.
 */
import { createAnthropicClient } from '@/lib/anthropic/client';
import { extractText, stripCodeFences } from '@/lib/anthropic/constants';
import { getCoreAiModel } from '@/lib/anthropic/model';
import { getConfigValue } from '@/lib/config';
import { queueAiCall } from '@/lib/ingestion/scheduler';
import { fenceUntrusted, UNTRUSTED_TEXT_RULE } from '@/lib/anthropic/untrusted';
import type { IntentMatch, IntentAssessment } from './types';

export const INTENT_SYSTEM_PROMPT = `You are a security analyst assessing the risk of a user request made to an AI assistant in a corporate environment.

You will receive:
1. The user's message text
2. Intent patterns that were matched (category + phrases)
3. The organisation's acceptable use policy (if configured)

Your job is to assess whether this request represents a genuine risk or is benign in context.

Respond with JSON only:
{
  "severity": "low" | "medium" | "high" | "critical",
  "reasoning": "1-2 sentence explanation of your assessment",
  "recommended_action": "What the admin should do about this"
}

Severity guidelines:
- low: Legitimate work that happened to match a pattern. No action needed.
- medium: Could be risky depending on context. Worth a quick review.
- high: Likely a policy concern. Needs investigation.
- critical: Clear policy violation or active threat. Immediate action required.

Be pragmatic: developers legitimately discuss databases, exports, and credentials. Focus on whether the request suggests unauthorised action, not just whether it mentions sensitive topics.

LANGUAGE: The message text may be written in any language, including Portuguese. Assess it on its meaning regardless of language. Always respond in English whatever the input language; when quoting matched phrases or evidence, keep the quote verbatim in its original language.

DATA PROTECTION CONTEXT: When personal data is involved, consider the data-protection obligations that may apply, such as the UK/EU GDPR and Brazil's LGPD (Lei 13.709/2018). A request that exposes personal data of Brazilian data subjects is an LGPD concern even though no EU data is involved.

${UNTRUSTED_TEXT_RULE} The message text is fenced this way.

WRITING STYLE: Use British English spelling throughout (e.g. organisation, behaviour, categorise). Use British punctuation. NEVER use em dashes or en dashes; use commas, colons, semicolons, or full stops instead.`;

const FALLBACK: IntentAssessment = {
  severity: 'medium',
  reasoning: 'Manual review recommended: AI assessment could not be completed.',
  recommendedAction: 'Review the flagged message manually.',
};

const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

/**
 * Only the four real levels are stored; anything else (a misspelling, free
 * text, a value a prompt talked the model into) becomes 'medium', the same
 * default the no-answer path already uses. Case-insensitive, so "High" stays
 * high.
 */
export function normaliseSeverity(value: unknown): IntentAssessment['severity'] {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (SEVERITIES as readonly string[]).includes(v) ? v as IntentAssessment['severity'] : 'medium';
}

export async function assessIntent(
  messageText: string,
  matches: IntentMatch[],
): Promise<IntentAssessment> {
  const apiKey = await getConfigValue('anthropicAiApiKey');
  if (!apiKey) {
    return {
      severity: matches[0]?.defaultSeverity || 'medium',
      reasoning: 'AI assessment unavailable: no API key configured. Severity based on category default.',
      recommendedAction: 'Configure an AI API key for contextual severity assessment.',
    };
  }

  const policy = await getConfigValue('acceptableUsePolicy');
  const matchSummary = matches.map(m =>
    `Category: ${m.categoryId} (${m.categoryName})\nMatched phrases: ${m.matchedPhrases.join(', ')}\nDefault severity: ${m.defaultSeverity}`
  ).join('\n\n');

  try {
    const client = createAnthropicClient(apiKey);
    const coreModel = await getCoreAiModel();
    const message = await queueAiCall(() => client.messages.create({
      model: coreModel,
      max_tokens: 512,
      system: INTENT_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Message text:\n${fenceUntrusted(messageText)}\n\nIntent matches:\n${matchSummary}\n\nAcceptable use policy:\n${policy || 'No policy configured.'}`,
      }],
    }));

    const parsed = JSON.parse(stripCodeFences(extractText(message)));
    return {
      severity: normaliseSeverity(parsed.severity),
      reasoning: parsed.reasoning || 'No reasoning provided.',
      recommendedAction: parsed.recommended_action || 'Review manually.',
    };
  } catch {
    return FALLBACK;
  }
}
