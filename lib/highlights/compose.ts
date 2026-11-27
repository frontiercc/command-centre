// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Weekly Highlights — the single LLM call. Takes the measured HighlightsInput,
 * returns the ONLY two model-authored parts of the post: the subject line and
 * up to six one-sentence deliverables. Everything numeric is injected later by
 * render.ts — the model NEVER renders a number, enforced two ways: the prompt
 * forbids digits, and validateComposed() drops any sentence containing one.
 * Every deliverable must trace to a supplied work item (the
 * validateAgainstCluster pattern from the retired emergent-suggestion job) — untraceable
 * sentences are dropped, never repaired. Output is redactPii-scrubbed on the
 * way OUT as well as the input having been scrubbed on the way IN (gather.ts).
 * Returns null on any API/parse/validation failure — the route explains rather
 * than sending a degraded post.
 */
import { withThinkingOff } from '@/lib/anthropic/thinking';
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient } from '@/lib/anthropic/client';
import { getConfigValue } from '@/lib/config';
import { extractText, stripCodeFences, parseModelJson } from '@/lib/anthropic/constants';
import { queueAiCall } from '@/lib/ingestion/scheduler';
import { redactPii } from '@/lib/pii/detect';
import { CONTENT_FULL_CHARS } from '@/lib/otel/content-limits';
import type { HighlightsInput, HighlightsWorkItem } from '@/lib/highlights/gather';
import { getClaudeCredential } from '@/lib/anthropic/credential';

export interface ComposedHighlights { subject: string; deliverables: { itemIndex: number; sentence: string }[] }

const MAX_DELIVERABLES = 6;

// Writing rules proven by hand — .claude/commands/ccc-weekly.md. Load-bearing.
const SYSTEM_PROMPT = `You write the opening of a weekly internal post about what a team produced with AI, from their real request text.
You are given numbered WORK ITEMS: real requests people made this week. Return JSON only:
{"subject": "...", "deliverables": [{"item": <number>, "sentence": "..."}]}
Rules, all hard:
- Up to six deliverables, each ONE sentence describing the finished piece of work from one work item. Lead with the finished thing; put the humble input at the end as the punchline (e.g. "A client-ready presentation on how two solutions support a reinsurer's business, from nothing but a meeting recording.").
- "subject": a short phrase naming what the team worked on, read from the requests themselves (e.g. "client proposals, systems integration and meeting analysis").
- The work is the subject of every sentence, never "someone did X". Never name a person, company, client, or product you were given; describe the work generically.
- NEVER write a digit. Spell out small numbers if needed.
- No internal vocabulary: no tiers, scores, signals, or jargon a reader would query.
- Never invent work that is not in a supplied item, and never claim what the work replaced.
- Skip items too thin or vague to describe honestly. Return ONLY the JSON object.`;

/**
 * The JSON object in the model's reply, even with a sentence or code fence around it, and with
 * raw line breaks inside strings repaired (parseModelJson). Null when there is no object to read.
 */
export function readReply(text: string): unknown | null {
  const raw = stripCodeFences(text);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return parseModelJson(raw.slice(start, end + 1));
}

export function validateComposed(parsed: unknown, workItems: HighlightsWorkItem[]): ComposedHighlights | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  const rawSubject = typeof o.subject === 'string' ? o.subject.trim() : '';
  if (rawSubject === '') return null;
  // Digit check runs pre-redaction, which is safe because every maskValue arm in
  // lib/pii/detect.ts only emits digits sourced from the matched substring (never
  // invents new ones) — a future mask template with literal digits would need this
  // re-ordered so a redaction artifact can't be mistaken for (or hide) a model-written number.
  if (/\d/.test(rawSubject)) return null;                                           // model never renders a number — drop-never-repair
  const subject = redactPii(rawSubject);
  const valid = new Set(workItems.map(w => w.index));
  const seen = new Set<number>();
  const deliverables: ComposedHighlights['deliverables'] = [];
  for (const d of Array.isArray(o.deliverables) ? o.deliverables : []) {
    if (typeof d !== 'object' || d === null) continue;
    const item = (d as Record<string, unknown>).item;
    const sentence = (d as Record<string, unknown>).sentence;
    if (typeof item !== 'number' || !valid.has(item) || seen.has(item)) continue;   // untraceable or duplicate → drop
    if (typeof sentence !== 'string' || sentence.trim() === '') continue;
    if (/\d/.test(sentence)) continue;                                              // model never renders a number
    seen.add(item);
    deliverables.push({ itemIndex: item, sentence: redactPii(sentence.trim()) });
    if (deliverables.length >= MAX_DELIVERABLES) break;
  }
  if (deliverables.length === 0) return null;
  return { subject, deliverables };
}

export async function composeHighlights(input: HighlightsInput): Promise<ComposedHighlights | null> {
  if (input.workItems.length === 0) return null;
  const apiKey = await getClaudeCredential();
  if (!apiKey) return null;
  const model = (await getConfigValue('highlightsModel')) || 'claude-sonnet-5';

  // Slice at CONTENT_FULL_CHARS (4,000) — the stored cap, raised specifically for this
  // feature (lib/otel/content-limits.ts) — kept as a defensive bound, not removed, in case
  // a future caller ever passes unbounded text into workItems.
  const itemLines = input.workItems
    .map(w => `Item ${w.index}${w.taskType ? ` (${w.taskType})` : ''}: ${JSON.stringify(w.text.slice(0, CONTENT_FULL_CHARS))}`)
    .join('\n');
  const userMsg = `WORK ITEMS:\n${itemLines}`;

  // Each way this can give up says why in the log (never the prompts or the model's text), so a
  // failed draft can be traced: the page shows one message for all of them.
  let message: Anthropic.Message;
  try {
    const client = createAnthropicClient(apiKey);
    message = await queueAiCall(() => client.messages.create(withThinkingOff({
      // Room for six full sentences and a subject: a reply cut off mid-JSON cannot be read.
      model, max_tokens: 3000, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: userMsg }],
    })));
  } catch (err) {
    const status = (err as { status?: number }).status;
    console.warn(`[Highlights] model call failed (model ${model}${status ? `, status ${status}` : ''})`);
    return null;
  }

  const parsed = readReply(extractText(message));
  if (parsed === null) {
    console.warn(`[Highlights] the reply was not readable JSON (stopped: ${message.stop_reason}, ${extractText(message).length} characters)`);
    return null;
  }
  const composed = validateComposed(parsed, input.workItems);
  if (!composed) {
    const o = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
    const subject = typeof o.subject === 'string' ? o.subject.trim() : '';
    const offered = Array.isArray(o.deliverables) ? o.deliverables.length : 0;
    const why = subject === '' ? 'no subject line' : /\d/.test(subject) ? 'the subject line contained a number' : `none of the ${offered} sentences could be kept (untraceable, empty or containing a number)`;
    console.warn(`[Highlights] draft rejected: ${why}`);
  }
  return composed;
}
