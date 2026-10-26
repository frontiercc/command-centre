// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// A JSON reply from the model whose every number must come from the prompt.
// Used by all the briefings, which used
// to store the model's text unchecked: one Code briefing
// stated a share the model had worked out wrongly ("28%" for ~35%) and a
// work-mix total that did not add up.
//
// The rule is simple and strict: a number in the model's text must appear in the
// system prompt or the user message (rounded forms allowed, via numberVariants).
// Callers therefore compute every share and change in code and put it in the
// prompt; the model never calculates. A rejected reply gets ONE more call that
// names the offending numbers; a second rejection throws GroundingRejectedError
// and the caller keeps the previous briefing and records the failure.
// A model-call error is thrown as-is (not counted as a rejection).
import type Anthropic from '@anthropic-ai/sdk';
import { extractText } from '@/lib/anthropic/constants';
import { extractNumbers, numberVariants, ungroundedNumbers } from '@/lib/anthropic/grounded-narrative';

// ─── Facts helpers: work figures out in code so the model never has to ───────

/** "+12%", "-5%", "no change", or null when there is no usable prior value. */
export function pctChange(current: number | null, prior: number | null): string | null {
  if (current === null || prior === null || !isFinite(current) || !isFinite(prior) || prior === 0) return null;
  const pct = Math.round(((current - prior) / prior) * 100);
  return pct === 0 ? 'no change' : `${pct > 0 ? '+' : ''}${pct}%`;
}

/** Whole-number percentage of part in total, or null. */
export function pctOf(part: number, total: number): number | null {
  return total > 0 ? Math.round((part / total) * 100) : null;
}

export class GroundingRejectedError extends Error {
  constructor(public readonly reasons: string[]) {
    super(`Model reply rejected twice: ${reasons.join('; ')}`);
    this.name = 'GroundingRejectedError';
  }
}

/** Every number in these texts, plus its rounded forms. */
export function allowedNumbersFrom(...texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    for (const raw of extractNumbers(t)) {
      out.add(raw);
      const n = parseFloat(raw);
      for (const v of numberVariants(n)) out.add(v);
    }
  }
  return out;
}

export interface GroundedShape<T> {
  /** Validate the parsed JSON and return it typed; throw on a wrong shape. */
  parse: (obj: unknown) => T;
  /** The model-written text fields whose numbers must be grounded. */
  texts: (value: T) => string[];
  /** Numbers the model is allowed to author itself (e.g. its own risk score). */
  extraAllowed?: (value: T) => number[];
  /**
   * Last resort after the retry is refused: remove what carries an unchecked
   * number (e.g. whole sentences) and return what is left, or null when too
   * little is left to use. The result is checked again before it is accepted,
   * so nothing unchecked is ever stored.
   */
  trim?: (value: T, isClean: (text: string) => boolean) => T | null;
}

export type GroundedCheck<T> = { ok: true; value: T } | { ok: false; reasons: string[] };

// Number words are checked like digits, so "four team members" must match a 4
// in the data. "one" is deliberately left out (it is ordinary prose: "one
// concrete action"), as are vague words (a few, half, twice, dozens).
const UNITS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const DIGIT_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };

/** The numbers written as words in `text`, as digit strings ("twenty-five" → "25"). */
export function numberWordsIn(text: string): string[] {
  const out: string[] = [];
  const re = /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[- ](one|two|three|four|five|six|seven|eight|nine)\b|\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\b/gi;
  for (const m of text.matchAll(re)) {
    const n = m[1] ? TENS[m[1].toLowerCase()] + DIGIT_WORDS[m[2].toLowerCase()] : (UNITS[m[3].toLowerCase()] ?? TENS[m[3].toLowerCase()]);
    out.push(String(n));
  }
  return out;
}

/** Pure: parse one reply and check its numbers against `allowed`. */
export function checkGroundedJson<T>(raw: string, allowed: Set<string>, shape: GroundedShape<T>): GroundedCheck<T> {
  // Accept bare JSON or a fenced block anywhere in the reply (some models add a preamble).
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const cleaned = fence ? fence[1].trim() : trimmed;
  let value: T;
  try {
    value = shape.parse(JSON.parse(cleaned));
  } catch {
    return { ok: false, reasons: ['the reply was not a JSON object in the required shape'] };
  }
  const ok = new Set(allowed);
  for (const n of shape.extraAllowed?.(value) ?? []) for (const v of numberVariants(n)) ok.add(v);
  const bad: string[] = [];
  for (const t of shape.texts(value)) {
    for (const b of ungroundedNumbers(t ?? '', ok)) if (!bad.includes(b)) bad.push(b);
    for (const w of numberWordsIn(t ?? '')) if (!ok.has(w) && !bad.includes(w)) bad.push(w);
  }
  if (bad.length) return { ok: false, reasons: [`it used numbers that are not in the data (${bad.join(', ')})`] };
  return { ok: true, value };
}

export interface GroundedJsonRequest<T> extends GroundedShape<T> {
  client: Anthropic;
  model: string;
  maxTokens: number;
  system: string;
  userMessage: string;
  temperature?: number;
  /**
   * Whole try-retry-trim cycles before giving up (default 1). A scheduled briefing passes 2:
   * refusals are chance events (the same briefing that was refused passed on its next run),
   * so one fresh cycle rescues most without weakening the check. Costs nothing unless refused.
   */
  cycles?: number;
}

/** Pure: does this text use only numbers (digits or number words) found in `ok`? */
export function textIsGrounded(text: string, ok: Set<string>): boolean {
  return ungroundedNumbers(text, ok).length === 0 && numberWordsIn(text).every(w => ok.has(w));
}

/** Pure: parse a reply without checking numbers (for the trim fallback). */
function parseReply<T>(raw: string, shape: GroundedShape<T>): T | null {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  try { return shape.parse(JSON.parse(fence ? fence[1].trim() : trimmed)); } catch { return null; }
}

/**
 * Call the model, check the reply, retry once with the reasons. If the retry is
 * refused too and the shape can `trim`, the offending sentences are dropped and
 * the rest is used (`trimmed: true`), rechecked first. Otherwise throws
 * GroundingRejectedError.
 */
export async function createGroundedJson<T>(req: GroundedJsonRequest<T>): Promise<{ value: T; attempts: 1 | 2; trimmed?: true }> {
  const cycles = Math.max(1, req.cycles ?? 1);
  let reasons: string[] = [];
  for (let cycle = 1; cycle <= cycles; cycle++) {
    const result = await groundedCycle(req);
    if ('value' in result) return result;
    reasons = result.reasons;
    if (cycle < cycles) console.warn(`[grounded-json] cycle ${cycle} of ${cycles} refused; trying a fresh reply`);
  }
  throw new GroundingRejectedError(reasons);
}

/** One cycle: a reply, one retry with the reasons, then the trim fallback. Never throws for a refusal. */
async function groundedCycle<T>(req: GroundedJsonRequest<T>): Promise<{ value: T; attempts: 1 | 2; trimmed?: true } | { reasons: string[] }> {
  const allowed = allowedNumbersFrom(req.system, req.userMessage);
  let reasons: string[] = [];
  let lastText = '';
  for (const attempt of [1, 2] as const) {
    const content = attempt === 1 ? req.userMessage : `${req.userMessage}

Your previous reply was not accepted: ${reasons.join('; ')}. Use only numbers that appear in the data above, exactly as written, and do not calculate new figures (no sums, differences or percentages of your own). Reply with the JSON object only.`;
    const message = await req.client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: 'user', content }],
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    });
    const text = extractText(message);
    lastText = text;
    const check = checkGroundedJson(text, allowed, req);
    if (check.ok) return { value: check.value, attempts: attempt };
    reasons = check.reasons;
    // Server log only: without the refused text nobody can tell a model
    // mistake from a check that is too strict.
    console.warn(`[grounded-json] attempt ${attempt} refused (${reasons.join('; ')}): ${text.replace(/\s+/g, ' ').slice(0, 400)}`);
  }
  if (req.trim) {
    const parsed = parseReply(lastText, req);
    if (parsed) {
      const ok = new Set(allowed);
      for (const n of req.extraAllowed?.(parsed) ?? []) for (const v of numberVariants(n)) ok.add(v);
      const trimmed = req.trim(parsed, (t) => textIsGrounded(t, ok));
      if (trimmed && req.texts(trimmed).every(t => textIsGrounded(t ?? '', ok))) {
        console.warn(`[grounded-json] kept the retry with the unchecked sentences removed (${reasons.join('; ')})`);
        return { value: trimmed, attempts: 2, trimmed: true };
      }
    }
  }
  return { reasons };
}

/** Pure: split prose into sentences (a full stop inside a number such as 2.20 does not split). */
export function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

/** Shape helper for the common {paragraphs[], ...strings} briefing replies. */
export function paragraphsShape<K extends string>(minParagraphs: number, stringFields: readonly K[]): GroundedShape<{ paragraphs: string[] } & Partial<Record<K, string>>> {
  return {
    parse: (obj) => {
      const o = obj as { paragraphs?: unknown } & Record<string, unknown>;
      if (!o || !Array.isArray(o.paragraphs) || o.paragraphs.length < minParagraphs || !o.paragraphs.every(p => typeof p === 'string')) {
        throw new Error('paragraphs missing');
      }
      const out = { paragraphs: o.paragraphs as string[] } as { paragraphs: string[] } & Partial<Record<K, string>>;
      for (const k of stringFields) if (typeof o[k] === 'string') (out as Record<string, unknown>)[k] = o[k];
      return out;
    },
    texts: (v) => [...v.paragraphs, ...stringFields.map(k => (v as Record<string, unknown>)[k]).filter((s): s is string => typeof s === 'string')],
    // Drop each sentence carrying an unchecked number; a paragraph left empty
    // goes; an optional string field with one is removed. Too little left
    // (under half the sentences, or under minParagraphs paragraphs) means no
    // briefing, as before.
    trim: (v, isClean) => {
      const before = v.paragraphs.reduce((n, p) => n + splitSentences(p).length, 0);
      const kept = v.paragraphs.map(p => splitSentences(p).filter(isClean));
      const after = kept.reduce((n, p) => n + p.length, 0);
      // Mostly unchecked means mostly wrong: keep last week's rather than a stub.
      if (after * 2 < before) return null;
      const paragraphs = kept.map(p => p.join(' ')).filter(p => p.length > 0);
      if (paragraphs.length < minParagraphs) return null;
      const out = { paragraphs } as { paragraphs: string[] } & Partial<Record<K, string>>;
      for (const k of stringFields) {
        const f = (v as Record<string, unknown>)[k];
        if (typeof f === 'string' && isClean(f)) (out as Record<string, unknown>)[k] = f;
      }
      return out;
    },
  };
}

/** Route-level options for errorResponse(): a refused briefing says so plainly (502). */
export function aiFailureOptions(err: unknown): { status?: number; message: string } {
  return err instanceof GroundingRejectedError
    ? { status: 502, message: 'The new briefing failed the number check twice, so the previous one is still shown. Details are in the server log.' }
    : { message: 'The AI request failed. Details are in the server log.' };
}
