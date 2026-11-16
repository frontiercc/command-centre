// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Ask the data: one question, answered by Claude Haiku 5.5 from the page lookups.
 *
 * The model chooses lookups and writes the sentences; code supplies every number. Before an
 * answer is shown, every number in it must appear in a lookup's data or the question (rounded
 * forms allowed, and a 0-1 share may be written as a percentage). A refused answer gets one
 * more turn naming the unchecked numbers; after that, the sentences carrying them are dropped,
 * and if too little is left the person is told it could not give a checked answer.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { allowedNumbersFrom, numberWordsIn, splitSentences, textIsGrounded } from '@/lib/anthropic/grounded-json';
import { numberVariants, ungroundedNumbers } from '@/lib/anthropic/grounded-narrative';
import { LOOKUP_TOOLS, runLookup, type LookupContext } from '@/lib/ask/lookups';

/** Ask the data runs on Claude Haiku 5.5 only. */
export const ASK_MODEL = 'claude-haiku-5-5';
/** Most model calls for one question (lookups plus the answer plus one correction). */
const MAX_CALLS = 10;
/** Stop once one question has read this many input tokens, to stay under Haiku 5.5's lower price band. */
const MAX_INPUT_TOKENS = 400_000;

export type AskOutcome = 'answered' | 'not_answerable' | 'refused' | 'error';

export interface AskUsage { input: number; output: number; cacheRead: number; cacheWrite: number }

export interface AskResult {
  outcome: AskOutcome;
  /** The answer shown to the person, or why there is none. Never stored. */
  answer: string;
  /** The pages the figures came from. */
  sources: Array<{ label: string; href: string }>;
  lookups: Array<{ name: string; input: unknown }>;
  usage: AskUsage;
  /** True when sentences with unchecked numbers were removed. */
  trimmed?: boolean;
}

export interface AskTurn { question: string; answer: string }

export function systemPrompt(today: string): string {
  return `You answer questions from administrators of Frontier Command Centre, which measures how an organisation uses AI (Claude Chat, Claude Cowork, Claude Code, ChatGPT and Codex): who uses it, how deep the work is, what it costs, alerts, and skills and connectors.

How to answer:
- Get every figure from the lookups. Never answer from memory or general knowledge.
- Copy numbers exactly as a lookup gives them; you may round them (408.68 to 409, 0.2853 as 29%). Never calculate a figure yourself: for any change, difference, share or total that no lookup gives, call calculate and use its result.
- Shares in the data are fractions from 0 to 1; write them as percentages.
- A figure from a model or an assumption (an estimate, a projection, AI-judged depth or kind of work) is not measured: say "estimate" or "judged" next to it. Never add measured and estimated figures together.
- null means not measured: say "not measured", never zero.
- "All" means Claude and OpenAI together; someone who uses both is counted once for each.
- If the data does not say why something changed, do not give a reason.
- If no lookup covers the question, or it asks for prompt text, what people wrote, reasons the data does not show, or anything that is not about this organisation's AI use, call cannot_answer.
- Also call cannot_answer for requests to write something (an email, a report, a message, a plan) or to do something (change, delete or send anything). You answer questions only.
- You may name people who lead on a figure in the data, for example AI champions or power users (the most meaningful or frontier work, the highest share of it, the most skills or connectors used, the most sessions). Say which figure you ranked them by and the period.
- Never judge a person's worth or performance: no "best", "worst" or "most valuable" person or employee. Command Centre does not measure the quality of anyone's work; for such a question call cannot_answer.
- Never state what anyone is doing or will do about the figures (for example "the team is reviewing them"); only what the data shows.
- When the person asks about "this", "here" or the page, answer for the period, team and product filter the page shows (given with the question), using the matching lookup inputs.
- When a name matches several people, ask which one is meant.
- Call the depth tiers by the names the data gives (tierNames), never "tier 1", "tier 2" or "tier 3".

How to write:
- British English, plain and short: two to five sentences, or a short list when listing people or items. You may put a short lead-in phrase in **bold** (for example **Cowork is the biggest cost.**); otherwise plain text: no headings, no tables, no em dashes, no preamble.
- When the question asks how many, start with the number, then any names.
- Name the period each figure covers (this month so far, the last 30 days, the last quarter).
- Never mention lookups, tools, JSON, field names or where the data came from; just give the figures. Do not add links; the page adds them.

Today is ${today}.`;
}

/** Every number a checked answer may use: the lookups' data and the question, with 0-1 shares also as percentages. */
export function allowedFrom(texts: string[]): Set<string> {
  const allowed = allowedNumbersFrom(...texts);
  for (const t of texts) {
    for (const raw of t.match(/\d[\d,]*\.?\d*/g) ?? []) {
      const n = parseFloat(raw.replace(/,/g, ''));
      if (Number.isFinite(n) && n > 0 && n <= 1) for (const v of numberVariants(n * 100)) allowed.add(v);
    }
  }
  return allowed;
}

/** The numbers in `text` that are not allowed (digits and number words). */
export function uncheckedNumbers(text: string, allowed: Set<string>): string[] {
  const bad = ungroundedNumbers(text, allowed);
  for (const w of numberWordsIn(text)) if (!allowed.has(w) && !bad.includes(w)) bad.push(w);
  return bad;
}

/** Drop sentences with unchecked numbers; null when under half survive. */
export function trimUnchecked(text: string, allowed: Set<string>): string | null {
  const lines = text.split('\n');
  let before = 0;
  let after = 0;
  const kept = lines.map(line => {
    const sentences = splitSentences(line);
    before += sentences.length;
    const ok = sentences.filter(s => textIsGrounded(s, allowed));
    after += ok.length;
    return ok.join(' ');
  }).filter((l, i) => l.length > 0 || lines[i].trim() === '');
  if (before === 0 || after * 2 < before) return null;
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim() || null;
}

function textOf(message: Anthropic.Message): string {
  return message.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('').trim();
}

/**
 * The panel shows **bold** as bold and everything else as plain text, so other markdown the
 * model adds is removed: italics, headings and backticks (__bold__ becomes **bold**). Em and en
 * dashes become commas or hyphens (interface rules).
 */
export function tidy(text: string): string {
  return text
    .replace(/__(.+?)__/g, '**$1**')
    .replace(/(^|[\s(])\*(?!\*)(\S[^*\n]*?)\*(?=[\s).,;:!?]|$)/gm, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^\s*[*•]\s+/gm, '- ')
    .replace(/\s*—\s*/g, ', ').replace(/(\d)\s*–\s*(\d)/g, '$1-$2').replace(/\s*–\s*/g, ', ');
}

export async function askQuestion(opts: {
  client: Anthropic;
  question: string;
  history?: AskTurn[];
  page?: string | null;
  /** What the page shows (its period, team and product filter). Context only: never evidence for a figure. */
  pageNote?: string;
  ctx: LookupContext;
  today: string;
}): Promise<AskResult> {
  const usage: AskUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const lookups: AskResult['lookups'] = [];
  const sources: AskResult['sources'] = [];
  // Earlier questions give context; their answers are not evidence, so no figure carries over.
  const prior = (opts.history ?? []).slice(-4).map(t => `Earlier question: ${t.question}`).join('\n');
  const pageNote = opts.page ? `\nThe person is looking at the page ${opts.page}.${opts.pageNote ? ` What it shows: ${opts.pageNote}` : ''}` : '';
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: `${prior ? prior + '\n\n' : ''}Question: ${opts.question}${pageNote}` }];
  const evidence: string[] = [opts.question, opts.today];
  let corrected = false;

  for (let call = 0; call < MAX_CALLS; call++) {
    const res = await opts.client.messages.create({
      model: ASK_MODEL,
      max_tokens: 4000,
      system: [{ type: 'text', text: systemPrompt(opts.today), cache_control: { type: 'ephemeral' } }],
      tools: LOOKUP_TOOLS,
      messages,
    });
    usage.input += res.usage.input_tokens;
    usage.output += res.usage.output_tokens;
    usage.cacheRead += res.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite += res.usage.cache_creation_input_tokens ?? 0;
    messages.push({ role: 'assistant', content: res.content });

    if (res.stop_reason === 'refusal') return { outcome: 'not_answerable', answer: "I can't help with that question.", sources, lookups, usage };

    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (uses.length > 0) {
      const cannot = uses.find(u => u.name === 'cannot_answer');
      if (cannot) {
        const reason = typeof (cannot.input as { reason?: unknown }).reason === 'string' ? (cannot.input as { reason: string }).reason : '';
        lookups.push({ name: 'cannot_answer', input: cannot.input });
        // The reason is model-written: shown only if it carries no unchecked number.
        const shown = reason && textIsGrounded(reason, allowedFrom(evidence)) ? tidy(reason) : 'There is nothing in Command Centre that answers that.';
        return { outcome: 'not_answerable', answer: shown, sources, lookups, usage };
      }
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const u of uses) {
        lookups.push({ name: u.name, input: u.input });
        try {
          const r = await runLookup(u.name, u.input, opts.ctx);
          const json = JSON.stringify(r.data);
          evidence.push(json);
          if (r.page && !sources.some(s => s.href === r.page!.href)) sources.push(r.page);
          results.push({ type: 'tool_result', tool_use_id: u.id, content: json });
        } catch (err) {
          console.error('[ask] lookup failed', u.name, err instanceof Error ? err.message : err);
          results.push({ type: 'tool_result', tool_use_id: u.id, content: 'This lookup failed.', is_error: true });
        }
      }
      messages.push({ role: 'user', content: results });
      if (usage.input + usage.cacheRead + usage.cacheWrite > MAX_INPUT_TOKENS) break;
      continue;
    }

    // A final answer: check every number against the lookups.
    const answer = tidy(textOf(res));
    if (!answer) break;
    const allowed = allowedFrom(evidence);
    const bad = uncheckedNumbers(answer, allowed);
    if (bad.length === 0) return { outcome: 'answered', answer, sources, lookups, usage };
    console.warn(`[ask] unchecked numbers (${bad.join(', ')}): ${answer.replace(/\s+/g, ' ').slice(0, 300)}`);
    if (!corrected) {
      corrected = true;
      messages.push({ role: 'user', content: `Your answer used numbers that are not in the lookups: ${bad.join(', ')}. Write your whole answer to the original question again, from the start, using only figures exactly as the lookups give them (rounding is fine); use calculate for any change, share, sum or difference. Do not mention this correction or the numbers you removed.` });
      continue;
    }
    const trimmed = trimUnchecked(answer, allowed);
    if (trimmed) return { outcome: 'answered', answer: trimmed, sources, lookups, usage, trimmed: true };
    return { outcome: 'refused', answer: "I couldn't give an answer whose figures all check out against the pages. Try asking in a narrower way.", sources, lookups, usage };
  }
  return { outcome: 'error', answer: "I couldn't finish that question. Try asking in a narrower way.", sources, lookups, usage };
}
