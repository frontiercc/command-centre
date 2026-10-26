// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Confirmation check for shape-only PII matches.
 *
 * A pattern that guesses from shape alone (see lib/pii/confirm-scope.ts) can
 * match a Salesforce record id, a UUID fragment or a version string as readily
 * as a real identifier. This asks Claude one question before the alert fires:
 * is this a genuine instance of that identifier, in this context.
 *
 * HARD RULE: every failure path returns 'confirmed'. No API key, a thrown
 * error, a timeout, a malformed reply or an unexpected value must never
 * suppress an alert — only an explicit 'dismissed' does. A check that can go
 * quiet on its own is worse than no check.
 *
 * Mirrors lib/intent/assess.ts, with one deliberate improvement: the reply is
 * schema-constrained by output_config rather than free-form JSON parsed inside
 * a try/catch. Do not copy the assess.ts parsing pattern here.
 */
import { createAnthropicClient } from '@/lib/anthropic/client';
import { extractText } from '@/lib/anthropic/constants';
import { redactPii } from '@/lib/pii/detect';
import { fenceUntrusted, UNTRUSTED_TEXT_RULE } from '@/lib/anthropic/untrusted';
import { getCoreAiModel } from '@/lib/anthropic/model';
import { getConfigValue } from '@/lib/config';
import { queueAiCall } from '@/lib/ingestion/scheduler';

export type PiiVerdict = 'confirmed' | 'dismissed';

/** The verdict plus the model's one-sentence justification (null when the
 *  check did not run or gave no usable reason). The reason is what turns a
 *  dismissal in the Audit Log from an assertion into evidence. */
export interface PiiVerdictResult {
  verdict: PiiVerdict;
  reason: string | null;
}

export const CONFIRM_SYSTEM_PROMPT = `You are checking whether a pattern match is a genuine instance of a personal identifier.

A detector matched a piece of text by its SHAPE alone. Shapes are easily matched by accident: a Salesforce record id can look like a UK National Insurance number, a software version like 1.2.3.4 looks exactly like an IP address, and a part code can look like a US social security number.

You will receive the message the match came from, the kind of identifier the detector thinks it found, and the matched value with its middle masked.

Decide ONE thing: is this a genuine instance of that kind of identifier, used as that kind of identifier, in this message.

- "confirmed": it is genuinely that identifier.
- "dismissed": the shape matched something else, such as an internal id, a version number, a hash, a reference code, a random string, or ordinary prose.

You are NOT deciding whether the value is sensitive, whether it should have been sent, or how serious it is. Only whether the detector identified it correctly.

When you cannot tell, answer "confirmed". A wrongly-dismissed real identifier is far worse than a wrongly-confirmed false one.

In your reason, describe WHAT the value is, never the value itself. Write "a warehouse order reference" or "a software version string", not the characters you were shown. The masked value is already recorded alongside your answer.

${UNTRUSTED_TEXT_RULE} The message is fenced this way.

WRITING STYLE: Use British English. Never use em dashes or en dashes.`;

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'dismissed'] },
    reason: { type: 'string', description: 'One short sentence.' },
  },
  required: ['verdict', 'reason'],
  additionalProperties: false,
} as const;

/**
 * Pure. Turns whatever came back into a verdict, defaulting to 'confirmed'
 * on anything that is not an explicit, exactly-spelled dismissal.
 */
export function parseVerdict(raw: string | null | undefined): PiiVerdict {
  return parseVerdictResult(raw).verdict;
}

/** As parseVerdict, but also returns the model's stated reason. Same fail-safe
 *  rule: anything that is not an exact lowercase 'dismissed' is a confirm. The
 *  reason is capped so a runaway reply cannot bloat a stored row, and is null
 *  unless it is a non-empty string. */
export function parseVerdictResult(raw: string | null | undefined): PiiVerdictResult {
  const none: PiiVerdictResult = { verdict: 'confirmed', reason: null };
  if (!raw) return none;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return none;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return none;
  const o = parsed as { verdict?: unknown; reason?: unknown };
  const verdict: PiiVerdict = o.verdict === 'dismissed' ? 'dismissed' : 'confirmed';
  // A reason is only kept when the model actually returned a verdict field.
  // A malformed reply that carries prose but no verdict must not attach a
  // justification to the confirm we fell back to — that would read in the
  // Audit Log as reasoning the model never gave for the outcome recorded.
  const verdictPresent = o.verdict === 'dismissed' || o.verdict === 'confirmed';
  // Masked even though the prompt asks the model not to quote the value.
  // This sentence is stored and shown in the compliance record, and every
  // other model-authored text in this codebase is scrubbed before storage
  // (lib/highlights/compose.ts, lib/usecases/impact-summary.ts). An
  // instruction is not a guarantee.
  const reason = verdictPresent && typeof o.reason === 'string' && o.reason.trim()
    ? redactPii(o.reason.trim()).slice(0, 300)
    : null;
  return { verdict, reason };
}

export async function confirmPiiMatch(
  messageText: string,
  piiType: string,
  maskedValue: string,
): Promise<PiiVerdictResult> {
  try {
    const apiKey = await getConfigValue('anthropicAiApiKey');
    if (!apiKey) return { verdict: 'confirmed', reason: null };

    const client = createAnthropicClient(apiKey);
    const model = await getCoreAiModel();
    const message = await queueAiCall(() => client.messages.create({
      model,
      max_tokens: 256,
      system: CONFIRM_SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: VERDICT_SCHEMA } },
      messages: [{
        role: 'user',
        content: `Identifier kind: ${piiType}\nMatched value (masked): ${maskedValue}\n\nMessage:\n${fenceUntrusted(messageText)}`,
      }],
    }));

    return parseVerdictResult(extractText(message));
  } catch {
    return { verdict: 'confirmed', reason: null };
  }
}
