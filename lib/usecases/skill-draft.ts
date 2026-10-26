// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * The one model call behind "Turn this into a skill".
 * Builds the prompt from the use case, the mined canvas (when there is one)
 * and the scrubbed, numbered excerpts; calls the Core AI model through the
 * shared AI queue; hands the text to the deterministic validator. Never
 * throws — every failure path resolves to { ok: false, reasons }. The model
 * is told what the process is, never how many people or sessions were seen:
 * every count on screen is measured by the corpus module.
 */
import { createAnthropicClient, LONG_AI_CALL_TIMEOUT_MS } from '@/lib/anthropic/client';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue } from '@/lib/config';
import { extractText } from '@/lib/anthropic/constants';
import { getCoreAiModel } from '@/lib/anthropic/model';
import { thinkingOff } from '@/lib/anthropic/thinking';
import { queueAiCall } from '@/lib/ingestion/scheduler';
import { filterCheckableSystemNames, findVerbatimRuns, parseRawDraft, validateSkillDraft, SKILL_SECTIONS, type ValidationResult } from '@/lib/usecases/skill-draft-validate';
import { distinctPromptCount, type SkillCorpus } from '@/lib/usecases/skill-corpus';
import type { ProcessCanvas } from '@/lib/usecases/suggestion-store';

export interface DraftUseCaseFacts { title: string; description: string | null; departments: string[] }
export interface CanvasFacts { story: string; rhythm: string; systems: string[]; tierNote: string | null }
export type CallModel = (args: { model: string; system: string; user: string }) => Promise<string>;
/** attempts: how many model calls were made, 1 to MAX_ATTEMPTS (a failed call is never retried). */
export interface GenerateResult { result: ValidationResult; model: string; attempts: 1 | 2 | 3 }

const MAX_TOKENS = 8000;
/** The first draft plus up to two repairs (was one repair). */
const MAX_ATTEMPTS = 3;

/**
 * The reply's fixed shape, enforced by the API (output_config), the same way
 * lib/pii/confirm.ts does it. Without it a model sometimes answered in prose
 * ("these excerpts are not one process"), which failed as "no parseable JSON"
 * on both attempts. The validator still checks every
 * rule; this only guarantees there is JSON to check.
 *
 * Each body section is its own required field and the code writes the
 * headings (assembleBody), so a section can never be missing or out of order:
 * a single body string lost its last two sections on two of eighteen live
 * drafts (localhost).
 */
const SECTION_NAMES = SKILL_SECTIONS.map(s => s.replace(/^## /, ''));

export const SKILL_DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    sections: {
      type: 'object',
      properties: Object.fromEntries(SECTION_NAMES.map(n => [n, { type: 'string' }])),
      required: SECTION_NAMES,
      additionalProperties: false,
    },
    ownerQuestions: { type: 'array', items: { type: 'string' } },
    citations: {
      type: 'object',
      properties: Object.fromEntries(SECTION_NAMES.map(n => [n, { type: 'array', items: { type: 'integer' } }])),
      required: SECTION_NAMES,
      additionalProperties: false,
    },
    excludedExcerpts: { type: 'array', items: { type: 'integer' } },
  },
  required: ['name', 'description', 'sections', 'ownerQuestions', 'citations', 'excludedExcerpts'],
  additionalProperties: false,
} as const;

/**
 * Turns a reply carrying `sections` into one carrying the Markdown `body` the
 * validator reads: the eight headings in fixed order, each followed by its
 * section text. A repeated heading at the start of a section is dropped, and a
 * stray "## " heading inside one is demoted to "### ", so neither can break the
 * fixed structure. A reply without `sections` (an older shape, or not JSON) is
 * returned unchanged for the parser to judge.
 */
export function assembleBody(text: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return text; }
  if (!parsed || typeof parsed !== 'object') return text;
  const o = parsed as Record<string, unknown>;
  const sections = o.sections;
  if (!sections || typeof sections !== 'object') return text;
  const s = sections as Record<string, unknown>;
  const body = SKILL_SECTIONS.map((heading, i) => {
    const name = SECTION_NAMES[i];
    const raw = typeof s[name] === 'string' ? (s[name] as string) : '';
    const escaped = name.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
    const content = raw
      .trim()
      .replace(new RegExp(`^#{1,6}\\s*${escaped}\\s*\\n+`, 'i'), '')
      .replace(/^## /gm, '### ')
      .trim();
    return `${heading}\n\n${content}`;
  }).join('\n\n');
  const { sections: _omit, ...rest } = o;
  void _omit;
  return JSON.stringify({ ...rest, body });
}

export function canvasFactsFrom(canvas: ProcessCanvas | null): CanvasFacts | null {
  if (!canvas) return null;
  return { story: canvas.story, rhythm: canvas.rhythm.display, systems: canvas.systems, tierNote: canvas.tierNote };
}

const SYSTEM = `You write an Agent Skill for Claude that codifies a recurring BUSINESS PROCESS a department already hands to its AI assistant, so that anyone in the department can run it the way its most experienced people already do.

You are given: the process title, a short description of how the work runs today (when known), the systems it reaches, and numbered excerpts of the department's real prompts in date order, from several people across several occasions. Excerpts marked "follow-up" are later messages in the same conversation: corrections and refinements. They are the most valuable signal: they become quality rules.

Rules, in priority order:
1. GROUNDED: every instruction must trace to something the excerpts ask for or correct. Where people differ, prefer what is repeated most and what is most recent.
2. NO IDENTITIES: never include a person's name, an email address, a company name, a file name, or quoted prompt text in the body. Refer to people by role only if the excerpts make the role obvious.
3. NUMBERS: the body may contain a digit sequence ONLY if that exact digit sequence appears in the excerpts (the message lists every one they contain). Write every count in words ("four columns", "the two biggest movers"), never as a numeral. Never invent example figures, sample percentages or sample amounts, not even marked as examples or illustrations. Copy any threshold exactly as the excerpts write it: "50k" stays "50k", never "50,000". Never add a currency symbol or a unit the excerpts do not state. List steps with "1.", "2.", and so on at the start of a line; those ordinals are allowed. Never mention how many people, sessions or prompts you were shown.
4. SYSTEMS: name only systems that appear in the description or the excerpts. Do not add tools.
5. UNCLEAR OR CONFLICTING: do not guess. Put it in ownerQuestions for the process owner to settle, and write the step so it asks the user.
6. Ignore excerpts that are clearly a different task from the process.
7. Do NOT write excerpt numbers or citation markers into the body. Citations go ONLY in the "citations" field.
8. The "description" is what Claude reads to decide whether to use the skill: say what the skill does, then when to use it, quoting the short trigger phrases a user actually types (a few words each), so the skill activates on the right requests.

Return ONLY a JSON object with these fields:
- "name": kebab-case, 1-64 chars, lowercase letters/digits/hyphens, no leading/trailing/double hyphen
- "description": 1-1024 chars. What the skill does AND when to use it, with the specific words a user would type
- "sections": the skill's body, one field per section: ${SECTION_NAMES.map(n => `"${n}"`).join(', ')}. Each is that section's Markdown content WITHOUT its heading (the headings are added for you); use "###" for any sub-heading, never "##". No YAML frontmatter. Plain, direct instructions addressed to Claude. Everything the rules above say about "the body" applies to these section texts.
- "ownerQuestions": array of short questions the process owner must confirm before publishing
- "citations": object mapping each section name (without "## ") to an array of the excerpt numbers it was drawn from
- "excludedExcerpts": array of excerpt numbers you judged to be a different task`;

function isoDay(epochS: number): string {
  return new Date(epochS * 1000).toISOString().slice(0, 10);
}

export function buildSkillDraftPrompt(uc: DraftUseCaseFacts, canvas: CanvasFacts | null, corpus: SkillCorpus): { system: string; user: string } {
  const lines: string[] = [`Process title: ${uc.title}`];
  if (uc.description) lines.push(`Description: ${uc.description}`);
  if (uc.departments.length) lines.push(`Department: ${uc.departments.join(', ')}`);
  if (canvas) {
    lines.push(`How it appears to run today: ${canvas.story}`);
    lines.push(`Rhythm: ${canvas.rhythm}`);
    if (canvas.tierNote) lines.push(`Delegation depth observed: ${canvas.tierNote}`);
  }
  const systems = [...new Set([...(canvas?.systems ?? []), ...corpus.systems])].sort();
  if (systems.length) lines.push(`Systems observed: ${systems.join(', ')}`);

  // The digit sequences the excerpts carry, deduplicated and sorted. This is a
  // measured fact about the corpus TEXT (which digits a threshold or rule
  // already uses), not a count of people, sessions or prompts, so it does not
  // breach the rule that measured counts never go to the model. It gives the
  // model the exact allow-list the validator's digit-run backstop enforces.
  const digits = [...new Set(corpus.excerpts.flatMap(e => e.text.match(/\d+/g) ?? []))]
    .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  lines.push(`Digits the prompts contain (the only digits you may use): ${digits.length ? digits.join(', ') : 'none'}`);

  const excerpts = corpus.excerpts
    .map(e => `[${e.index}] (${isoDay(e.occurredAt)}, person ${e.personLabel}${e.isFollowUp ? ', follow-up' : ''})\n${e.text}`)
    .join('\n\n');

  return { system: SYSTEM, user: `${lines.join('\n')}\n\n--- Excerpts (${corpus.excerpts.length}) ---\n\n${excerpts}` };
}

const defaultCallModel: CallModel = async ({ model, system, user }) => {
  const apiKey = await getConfigValue('anthropicAiApiKey');
  if (!apiKey) throw new Error('No AI API key configured');
  const client = createAnthropicClient(apiKey, { timeoutMs: LONG_AI_CALL_TIMEOUT_MS });
  const off = thinkingOff(model);
  const res = await queueAiCall(() => client.messages.create({
    model, max_tokens: MAX_TOKENS, system, messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema: SKILL_DRAFT_SCHEMA }, ...(off.effort ? { effort: off.effort } : {}) },
    // Thinking off. Sonnet 5 thinks by default and the thinking counts against
    // max_tokens: on localhost six of twenty-six replies with it on
    // were cut off at 8,000 and two drafts were lost, while with it off none of
    // eighteen drafts was cut off. A finished skill needs about 2,000 tokens.
    // thinkingOff picks the setting the configured model accepts.
    ...(off.thinking ? { thinking: off.thinking } : {}),
  }));
  return extractText(res);
};

function repairMessage(user: string, reasons: string[], previous: string, copied: string[]): string {
  // Every copied passage is named so the model can reword them all; the stored
  // reasons never carry prompt text.
  const hint = copied.length
    ? `\nReword these passages, which repeat a prompt word for word:\n${copied.map(c => `- "${c}"`).join('\n')}`
    : '';
  return `${user}\n\nYour previous answer was rejected for these reasons:\n${reasons.map(r => `- ${r}`).join('\n')}${hint}\nReturn the corrected JSON object only. Fix exactly these problems and change nothing else.\n\n${previous}`;
}

/**
 * One draft, with up to two automatic repairs: when an answer fails to parse
 * or validate, the same model is called again with the rejection reasons and
 * that answer fed back. A model-call failure is never retried. When the last
 * attempt still fails but some attempt failed only minor checks (a copied
 * passage, an uncited section), that draft is returned as a success with a
 * note per problem in its owner questions, for the owner to settle before
 * download, rather than failing the click. Never throws.
 */
export async function generateSkillDraft(
  uc: DraftUseCaseFacts,
  canvas: CanvasFacts | null,
  corpus: SkillCorpus,
  knownSystems: string[],
  callModel: CallModel = defaultCallModel,
  /** The configured skill-drafting model (`skillDraftModel`); blank/undefined falls back to the Core AI model. */
  modelOverride?: string,
): Promise<GenerateResult> {
  const model = modelOverride && modelOverride.trim() ? modelOverride.trim() : await getCoreAiModel();
  const { system, user } = buildSkillDraftPrompt(uc, canvas, corpus);
  const validationCorpus = {
    excerpts: corpus.excerpts.map(e => ({ index: e.index, text: e.text })),
    // Thin coverage is citations over what the model was SHOWN, so it counts the
    // sampled excerpts, not the full-evidence stat (which can be far larger).
    distinctPrompts: distinctPromptCount(corpus.excerpts.map(e => e.text)),
    systems: corpus.systems,
  };

  const runOnce = async (userMessage: string): Promise<{ result: ValidationResult; text: string | null; copied: string[] }> => {
    let text: string;
    try {
      text = await callModel({ model, system, user: userMessage });
    } catch (err) {
      return { text: null, copied: [], result: { ok: false, reasons: [`model call failed: ${err instanceof Error ? err.message : String(err)}`] } };
    }
    const raw = parseRawDraft(assembleBody(text));
    if (!raw) return { text, copied: [], result: { ok: false, reasons: ['model returned no parseable JSON'] } };
    const result = validateSkillDraft(raw, validationCorpus, knownSystems);
    return { text, result, copied: result.ok ? [] : findVerbatimRuns(raw.body, validationCorpus.excerpts) };
  };

  let attempt = await runOnce(user);
  let attempts = 1;
  let fallback = !attempt.result.ok ? attempt.result.fallback : undefined;
  while (!attempt.result.ok && attempt.text !== null && attempts < MAX_ATTEMPTS) {
    attempt = await runOnce(repairMessage(user, attempt.result.reasons, attempt.text, attempt.copied));
    attempts++;
    if (!attempt.result.ok && attempt.result.fallback) fallback = attempt.result.fallback;
  }
  const n = attempts as GenerateResult['attempts'];
  if (attempt.result.ok) return { model, result: attempt.result, attempts: n };
  if (fallback) return { model, result: { ok: true, draft: fallback }, attempts: n };
  return { model, result: attempt.result, attempts: n };
}

/**
 * The "known systems" list the validator checks against: EVERY org-wide
 * connector name, plus only those skill names that carry a namespace or a
 * hyphen. Bare single-token skill names (`review`, `run`, `docs`, `pdf`) are
 * ordinary English and would reject plain sentences, so they are left out;
 * see filterCheckableSystemNames.
 */
export async function listKnownSystemNames(): Promise<string[]> {
  const client = await getTypedClient();
  const si = schema.coworkSkillInvocations;
  const mi = schema.coworkMcpInvocations;
  const skills = await client.selectDistinct({ v: si.skill_name }).from(si);
  const conns = await client.selectDistinct({ v: mi.mcp_server }).from(mi);
  const skillNames = filterCheckableSystemNames(skills.map(r => r.v).filter((v): v is string => !!v));
  const connectorNames = conns.map(r => r.v).filter((v): v is string => !!v);
  return [...new Set([...skillNames, ...connectorNames])].sort();
}
