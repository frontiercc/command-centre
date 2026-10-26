// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Grounded LLM narrative over deterministic InsightFacts. The model
 * is only allowed to restate/interpret facts already computed elsewhere —
 * it must never invent a number. Every numeric token in the reply is
 * validated against the set of numbers derivable from `facts`; any miss
 * rejects the whole narrative (mirrors the grounding discipline in
 * the retired emergent-suggestion validator).
 *
 * Never throws: any failure (missing API key, model error, ungrounded
 * output) resolves to `{ text: null }` so a caller can render a graceful
 * "no narrative available" fallback.
 *
 * The grounding primitives (numberVariants/extractNumbers/isGrounded) live in
 * lib/anthropic/grounded-narrative.ts, shared with lib/usecases/impact-summary.ts —
 * do not fork a local copy here again.
 */
import { createAnthropicClient } from '@/lib/anthropic/client';
import { getConfigValue } from '@/lib/config';
import { extractText } from '@/lib/anthropic/constants';
import { numberVariants, isGrounded } from '@/lib/anthropic/grounded-narrative';
import type { InsightFacts } from '@/lib/finance/insights';

function buildPrompt(facts: InsightFacts): string {
  return `You are writing ONE short paragraph (2-4 sentences) summarising the following cost/chargeback facts for a finance stakeholder.
ONLY restate and interpret the numbers and fields given below. Do NOT invent, estimate, guess, or add any number, percentage, date, name, or fact that is not present in this JSON. If a field is null, do not mention a value for it.

FACTS (JSON):
${JSON.stringify(facts)}

Write the paragraph now. Plain prose only, no markdown, no headings, no bullet points.`;
}

async function callRealModel(prompt: string): Promise<string> {
  const apiKey = await getConfigValue('anthropicAiApiKey');
  if (!apiKey) throw new Error('No AI API key configured');
  const model = (await getConfigValue('financeInsightModel')) || 'claude-haiku-4-5-20251001';
  const client = createAnthropicClient(apiKey);
  const message = await client.messages.create({
    model,
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });
  return extractText(message);
}

/** Collect every numeric field in InsightFacts into a set of allowed string forms. */
function buildAllowedNumbers(facts: InsightFacts): Set<string> {
  const allowed = new Set<string>();
  const add = (n: number | null | undefined) => {
    if (n === null || n === undefined) return;
    for (const v of numberVariants(n)) allowed.add(v);
  };

  if (facts.biggestMover) {
    add(facts.biggestMover.deltaUsd);
    add(facts.biggestMover.deltaPct);
  }
  add(facts.concentration.topCentrePct);
  add(facts.concentration.topUsersPct);
  if (facts.projection) {
    add(facts.projection.projectedUsd);
    add(facts.projection.priorUsd);
    add(facts.projection.vsPriorPct);
  }
  add(facts.dataQuality.unallocatedPct);
  add(facts.dataQuality.unpricedModelCount);

  return allowed;
}

export async function generateInsightNarrative(
  facts: InsightFacts,
  deps?: { callModel?: (prompt: string) => Promise<string> }
): Promise<{ text: string | null }> {
  try {
    const callModel = deps?.callModel ?? callRealModel;
    const reply = await callModel(buildPrompt(facts));
    if (typeof reply !== 'string' || reply.trim() === '') return { text: null };
    if (!isGrounded(reply, buildAllowedNumbers(facts))) return { text: null };
    return { text: reply.trim() };
  } catch {
    return { text: null };
  }
}
