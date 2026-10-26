// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Grounded LLM narrative + cache for a single use case's Workflow Impact view.
 * Mirrors lib/finance/insight-narrative.ts's
 * grounding discipline via the shared lib/anthropic/grounded-narrative.ts
 * helpers: the model may only restate numbers already present in a
 * deterministic facts object built from `UseCaseImpact` — any invented number
 * rejects the whole narrative. Never throws; any failure resolves to
 * `{ text: null }` so the caller can render a graceful fallback / 502.
 *
 * The generated text is PII-redacted before being returned/cached (it will
 * be surfaced verbatim in the UI, same trust level as the Weekly Highlights
 * Slack draft).
 */
import { createAnthropicClient } from '@/lib/anthropic/client';
import { eq } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue } from '@/lib/config';
import { extractText } from '@/lib/anthropic/constants';
import { getOrgBriefingModel } from '@/lib/anthropic/model';
import { numberVariants, isGrounded } from '@/lib/anthropic/grounded-narrative';
import { redactPii } from '@/lib/pii/detect';
import { queueAiCall } from '@/lib/ingestion/scheduler';
import type { UseCaseImpact } from '@/lib/usecases/impact';

interface ImpactSummaryFacts {
  title: string;
  weeksMeasured: number;
  totalSessions: number;
  totalDurationHours: number | null;
  estimateHours: number | null;
  topSkills: string[];
  topConnectors: string[];
  topModel: string | null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function secsToHours(secs: number | null): number | null {
  return secs === null ? null : round1(secs / 3600);
}

function buildFacts(ucTitle: string, impact: UseCaseImpact): ImpactSummaryFacts {
  const weeksMeasured = impact.weeks.filter(w => w.sessions !== null).length;

  return {
    title: ucTitle,
    weeksMeasured,
    totalSessions: impact.totals.sessions,
    totalDurationHours: secsToHours(impact.totals.durationSecs),
    estimateHours: impact.totals.estimateHours === null ? null : round1(impact.totals.estimateHours),
    // Friction facts removed, as from the panel: raw counts with no rate/baseline invited
    // unsupported conclusions — the summary must not narrate them either.
    topSkills: impact.participation.skills.slice(0, 3).map(s => s.name),
    topConnectors: impact.participation.connectors.slice(0, 3).map(c => c.name),
    topModel: impact.participation.models[0]?.name ?? null,
  };
}

/**
 * Recursively collect every number allowed to appear in the model's reply: only
 * numeric fact values contribute (their numberVariants), via recursion into
 * arrays/objects. String fact values contribute NOTHING here — a digit embedded
 * in a string fact (e.g. topModel 'claude-haiku-4-5') must never widen the
 * allowed-number set, or a hallucinated number that happens to match one of
 * those digits (e.g. "5 hours") would pass grounding regardless of context.
 * Instead, digit-bearing string facts are handled by stripping their exact,
 * case-insensitive occurrences out of the reply before grounding (see
 * `stripFactStrings`) — so naming the fact string verbatim is fine, but a
 * bare digit reused out of context is not.
 */
function collectAllowedNumbers(value: unknown, allowed: Set<string>): void {
  if (typeof value === 'number') {
    for (const v of numberVariants(value)) allowed.add(v);
  } else if (Array.isArray(value)) {
    for (const item of value) collectAllowedNumbers(item, allowed);
  } else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) collectAllowedNumbers(v, allowed);
  }
}

/** Collect every numeric field in ImpactSummaryFacts into a set of allowed string forms. Never string leaves — see collectAllowedNumbers. */
function buildAllowedNumbers(facts: ImpactSummaryFacts): Set<string> {
  const allowed = new Set<string>();
  collectAllowedNumbers(facts, allowed);
  return allowed;
}

/** Recursively collect every non-empty string fact leaf (title, topModel, topSkills/topConnectors entries, …) — same walk shape as collectAllowedNumbers, but over strings instead of numbers. */
function collectFactStrings(value: unknown, strings: Set<string>): void {
  if (typeof value === 'string') {
    if (value.length > 0) strings.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectFactStrings(item, strings);
  } else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) collectFactStrings(v, strings);
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the pattern used to strip one fact string out of a reply. A fact
 * string containing at least one letter (a model/skill/connector/title name)
 * gets a separator-flexible pattern: split on hyphen/underscore/colon/
 * whitespace runs, regex-escape each part, and rejoin with a flexible
 * separator class — so 'claude-sonnet-5' also strips the model's natural
 * humanised renderings ("Claude Sonnet 5", "claude sonnet 5"), which is how
 * the model actually writes these names in prose. A fact string with NO
 * letters (pure digits/punctuation) keeps the old exact-escape behaviour —
 * loosening a purely numeric name into a separator-flexible pattern would
 * risk matching digits that aren't really the fact.
 */
function buildFactPattern(s: string): RegExp {
  if (!/[A-Za-z]/.test(s)) {
    return new RegExp(escapeRegExp(s), 'gi');
  }
  const parts = s.split(/[-_:\s]+/).filter(Boolean).map(escapeRegExp);
  return new RegExp(parts.join('[-_:\\s]*'), 'gi');
}

/**
 * Remove every occurrence of every string fact value (title, topModel,
 * topSkills/topConnectors entries, …) from `reply`, longest strings first so
 * a longer fact (e.g. 'claude-sonnet-5') is stripped before a shorter one
 * that might overlap with it, replacing each match with a single space. Used
 * ONLY to build the text that grounding is checked against — the
 * stored/returned reply is always the original, untouched string. This is
 * what makes a digit embedded in a named fact string legitimate (the model
 * reproduced the fact, in its own words or verbatim) while a bare digit
 * reused out of context is not (it survives stripping and must be
 * independently grounded as a number).
 */
export function stripFactStrings(reply: string, facts: ImpactSummaryFacts): string {
  const strings = new Set<string>();
  collectFactStrings(facts, strings);
  const sorted = [...strings].sort((a, b) => b.length - a.length);
  let stripped = reply;
  for (const s of sorted) {
    stripped = stripped.replace(buildFactPattern(s), ' ');
  }
  return stripped;
}

function buildPrompt(facts: ImpactSummaryFacts): string {
  return `You are writing ONE short paragraph (2-3 sentences) summarising the following measured usage facts about the use case "${facts.title}" for a workflow owner audience.
ONLY restate and interpret the numbers and fields given below. Do NOT invent, estimate, guess, or add any number, percentage, date, name, or fact that is not present in this JSON. If a field is null, do not mention a value for it.
When you mention a skill, connector, or model name, reproduce it exactly as written in the facts.

FACTS (JSON):
${JSON.stringify(facts)}

Write the paragraph now. Plain prose only, no markdown, no headings, no bullet points.`;
}

async function callRealModel(prompt: string): Promise<string> {
  const apiKey = await getConfigValue('anthropicAiApiKey');
  if (!apiKey) throw new Error('No AI API key configured');
  const model = await getOrgBriefingModel();
  const client = createAnthropicClient(apiKey);
  const message = await queueAiCall(() =>
    client.messages.create({
      model,
      max_tokens: 384,
      messages: [{ role: 'user', content: prompt }],
    })
  );
  return extractText(message);
}

export async function generateImpactSummary(
  ucId: string, // eslint-disable-line @typescript-eslint/no-unused-vars -- kept for signature parity / future call-site logging
  ucTitle: string,
  impact: UseCaseImpact,
  deps?: { callModel?: (prompt: string) => Promise<string> },
): Promise<{ text: string | null }> {
  try {
    const facts = buildFacts(ucTitle, impact);
    const callModel = deps?.callModel ?? callRealModel;
    const reply = await callModel(buildPrompt(facts));
    if (typeof reply !== 'string' || reply.trim() === '') return { text: null };
    if (!isGrounded(stripFactStrings(reply, facts), buildAllowedNumbers(facts))) return { text: null };
    return { text: redactPii(reply.trim()) };
  } catch {
    return { text: null };
  }
}

export async function saveImpactSummary(ucId: string, text: string, nowS: number): Promise<void> {
  const client = await getTypedClient();
  await client
    .update(schema.useCases)
    .set({ impact_summary: text, impact_summary_at: nowS })
    .where(eq(schema.useCases.id, ucId));
}
