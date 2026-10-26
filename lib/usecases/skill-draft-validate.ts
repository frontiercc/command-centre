// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic checks on a model-drafted Agent Skill ("Turn this into a
 * skill"). Pure and client-safe (the panel imports
 * sectionCitationCounts). The three guardrails, mechanised: nothing in the
 * skill the prompts did not say (numbers, units, systems, verbatim copies,
 * citations that exist); nothing personal gets through (redactPii + identity
 * patterns); and the citation counts that let the panel say how firm each
 * section is. An edit by the owner is checked more lightly (validateEdit) —
 * the owner is accountable for a number they type themselves.
 *
 * `lib/pii/detect.ts` has no imports of its own (confirmed before relying on
 * it here). `lib/highlights/gather.ts`'s `stripIdentity` is NOT imported —
 * that module pulls in DB code — so the identity-leak checks below (email/
 * URL/path patterns) are inlined instead of reusing it.
 */
import { redactPii } from '@/lib/pii/detect';

/**
 * The body's sections. There is no "When to use this skill" section: Claude
 * picks a skill from its description alone, so the trigger phrases belong
 * there, and a body copy of them was read only after the skill had already
 * been chosen.
 */
export const SKILL_SECTIONS = [
  '## Purpose',
  '## What to ask for before starting',
  '## Steps',
  '## Output format',
  '## Quality rules',
  '## Edge cases',
  '## Not part of this skill',
] as const;

/** The eight-section layout older drafts were written in; still accepted on edit so those drafts stay editable. */
export const LEGACY_SKILL_SECTIONS = [
  '## Purpose',
  '## When to use this skill',
  '## What to ask for before starting',
  '## Steps',
  '## Output format',
  '## Quality rules',
  '## Edge cases',
  '## Not part of this skill',
] as const;

export interface RawSkillDraft {
  name: string;
  description: string;
  body: string;
  ownerQuestions: string[];
  citations: Record<string, number[]>;
  excludedExcerpts: number[];
}

export interface ValidatedSkillDraft {
  name: string;
  description: string;
  body: string;
  ownerQuestions: string[];
  citations: Record<string, number[]>;
  thin: boolean;
}

/**
 * `fallback` is set when every failure is a minor one (a passage copied from a
 * prompt, a section with no citation): the draft can still be handed to the
 * owner, with a note per problem added to its owner questions, instead of
 * failing. Anything else (an invented number or unit, a
 * system not in the evidence, personal data, a broken structure) never has one.
 */
export type ValidationResult =
  | { ok: true; draft: ValidatedSkillDraft }
  | { ok: false; reasons: string[]; fallback?: ValidatedSkillDraft };

export interface ValidationCorpus {
  excerpts: Array<{ index: number; text: string }>;
  distinctPrompts: number;
  systems: string[];
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MUST_CITE = ['Steps', 'Quality rules'];
const THIN_COVERAGE = 0.25;
const COPY_RUN_WORDS = 12;

/** Escape raw control characters INSIDE JSON strings; whitespace between tokens is untouched. */
export function sanitiseJson(src: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  for (const ch of src) {
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      const code = ch.charCodeAt(0);
      if (code < 0x20) { out += code === 10 ? '\\n' : code === 9 ? '\\t' : ''; continue; }
      out += ch;
      continue;
    }
    if (ch === '"') inStr = true;
    out += ch;
  }
  return out;
}

export function parseRawDraft(text: string): RawSkillDraft | null {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  let parsed: unknown;
  try { parsed = JSON.parse(sanitiseJson(stripped)); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const strArr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const numArr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : []);
  const citations: Record<string, number[]> = {};
  if (p.citations && typeof p.citations === 'object') {
    for (const [k, v] of Object.entries(p.citations as Record<string, unknown>)) citations[k.replace(/^## /, '')] = numArr(v);
  }
  return {
    name: str(p.name).trim(),
    description: str(p.description).trim(),
    body: str(p.body).trim(),
    ownerQuestions: strArr(p.ownerQuestions),
    citations,
    excludedExcerpts: numArr(p.excludedExcerpts),
  };
}

export function isValidSkillName(name: string): boolean {
  return name.length >= 1 && name.length <= 64 && NAME_RE.test(name);
}

function sectionNames(layout: readonly string[] = SKILL_SECTIONS): string[] {
  return layout.map(h => h.replace(/^## /, ''));
}

function bodyHeadings(body: string): string[] {
  return [...body.matchAll(/^## .+$/gm)].map(m => m[0].trim());
}

function matchesLayout(headings: string[], layout: readonly string[]): boolean {
  return headings.length === layout.length && headings.every((h, i) => h === layout[i]);
}

/** The layout a body is written in: the legacy eight-section one when it matches exactly, else the current one. */
function layoutOf(body: string): readonly string[] {
  return matchesLayout(bodyHeadings(body), LEGACY_SKILL_SECTIONS) ? LEGACY_SKILL_SECTIONS : SKILL_SECTIONS;
}

/** A generated draft must use the current layout; an owner's edit may keep the legacy one (allowLegacy). */
function checkSections(body: string, allowLegacy = false): string | null {
  const headings = bodyHeadings(body);
  const expected = [...SKILL_SECTIONS];
  if (matchesLayout(headings, expected)) return null;
  if (allowLegacy && matchesLayout(headings, LEGACY_SKILL_SECTIONS)) return null;
  const missing = expected.filter(h => !headings.includes(h));
  if (missing.length) return `missing or misordered sections: ${missing.map(h => h.replace(/^## /, '')).join(', ')}`;
  // Nothing is missing, so either there's a genuine extra "##" heading
  // (e.g. a duplicate — headings.length is now higher than expected), or
  // all eight are present at the right count but in the wrong order.
  if (headings.length !== expected.length) return 'unexpected extra "##" heading in body';
  return 'sections are out of order';
}

// Rule 5: every numeric token the BODY or DESCRIPTION carries must have been carried by the
// prompts. A token is a number plus whatever currency symbol and unit are
// ATTACHED to it. One tokeniser and one normalisation run over both sides;
// the only asymmetry is that the stated set is widened with the forms that
// DROP a stated currency and/or unit (`$50k` licenses `$50k`, `$50`, `50k`,
// `50`) — the body may drop either, never add one.
//
// Shapes, in the order the regex tries them at each position:
// - Letter-prefixed identifiers (`Q3`, `FY25`, `Sprint42`, `week52`, `v2.1`,
//   `Q4s`, `v2beta`): a letter run glued to digits, optionally followed by
//   more letters/digits, word-bounded. The token is the CORE — the leading
//   letters plus the number (`q4`, `sprint42`, `v2`), lowercased; letters
//   after the number are not part of it, so `v2beta` against a stated `v2`
//   passes (the digits are the same) while an invented `Q4` against a stated
//   `Q3` fails. A stated `Sprint 42` (with a space) is the bare token `42`
//   and does NOT license a body `Sprint42` — that is deliberately fail-closed.
// - Numbers, with an optional currency symbol glued or one space before
//   (`$50`, `$ 50` -> `$50`), a sign only when the hyphen is not glued to a
//   preceding word (`a -5% move`, never the `-15` of `10-15`), and an
//   optional unit that is EITHER any letter run glued to the digits (`48h`,
//   `10gb`, `2x`, `5th`) OR a space/hyphen-joined word from UNIT_WORDS
//   (`48 h`, `5-day`, `2 hours`). Any other following word is not a unit, so
//   `3 short paragraphs` is the token `3`, not `3short`.
// - Ranges are TWO tokens: `10-15%` is `10` and `15%`. The hyphen is followed
//   by a digit, so it is not a unit joiner, and the second number is not
//   signed because the hyphen is glued to the first. A body range therefore
//   passes exactly when both of its numbers were stated in those forms.
// Normalisation: lowercase, drop the joiner between number and unit (`5-day`,
// `5 day`, `5day` -> `5day`), drop the space after a currency symbol, and fold
// plural/synonym units onto one spelling (`hours`/`hrs`/`hr` -> `h`, `days` ->
// `day`, `minutes`/`mins` -> `min`, `seconds`/`secs`/`sec` -> `s`, `percent`/
// `pct` -> `%`) so ordinary rewording ("2-hour" against "2 hours", "5 percent"
// against "5%") is not read as an invented unit.
//
// UNIT_WORDS is the set of words that count as a unit when SEPARATED from the
// number by a space or hyphen: magnitude suffixes, percent, multiples, time
// units (seconds to years, am/pm), storage sizes, and ordinal suffixes. It is
// a practical list, not exhaustive — a unit word missing from it is read as an
// ordinary word, so the token is the bare number. The digit-run backstop
// below is what guarantees no NUMBER is ever invented; this list is what
// catches an added or swapped unit. A bare `s` is deliberately absent (only
// glued, `5s`, is a unit), so "5 s" in prose is not read as seconds.
const UNIT_WORDS = [
  '%', 'k', 'm', 'bn', 'x', 'h', 'hr', 'hrs', 'hour', 'hours', 'min', 'mins', 'minute', 'minutes',
  'sec', 'secs', 'second', 'seconds', 'percent', 'pct',
  'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years', 'am', 'pm',
  'gb', 'mb', 'kb', 'tb', 'st', 'nd', 'rd', 'th',
] as const;
const UNIT_CANON: Record<string, string> = {
  hr: 'h', hrs: 'h', hour: 'h', hours: 'h',
  mins: 'min', minute: 'min', minutes: 'min',
  sec: 's', secs: 's', second: 's', seconds: 's',
  percent: '%', pct: '%',
  days: 'day', weeks: 'week', months: 'month', years: 'year',
};
const JOINED_UNITS = UNIT_WORDS.filter(u => u !== '%').sort((a, b) => b.length - a.length).join('|');
const NUMBER_RE = new RegExp(
  // 1: letter-prefixed identifier's core (leading letters + number); trailing letters/digits consumed, not captured
  String.raw`(?<!\w)([a-z]+\d+(?:\.\d+)*)[a-z0-9]*(?!\w)` +
  // 2: currency, 3: sign, 4: number, 5: glued letters, 6: %, 7: joined allowlisted unit
  String.raw`|(?:([$£€])\s?|(?<![\w$£€]))(-)?(\.?\d+(?:[.,]\d+)*)(?:([a-z]+)|[ -]?(%)|[ -](${JOINED_UNITS})(?![a-z]))?`,
  'gi',
);
// List ordinals ("1. " to "20. ") at the START of a line are structural, not
// a stated number — strip them before scanning. A number elsewhere in prose
// (including a single digit) is still a number.
const ORDINAL_RE = /^\s*(?:[1-9]|1\d|20)\.\s/gm;

interface NumericToken { currency: string; number: string; unit: string }

function stripOrdinals(text: string): string {
  return text.replace(ORDINAL_RE, ' ');
}

/**
 * Digit-run backstop (rule 5's structural guarantee). Every maximal run of
 * decimal digits, whatever letters or symbols surround it (`ticket_123`,
 * `5_000`, `Q4s`), after stripping list ordinals — the same extraction on
 * the body and on the excerpts. A body digit run the excerpts never carried
 * is an invented number even if the tokeniser did not recognise its shape.
 * Dropping a currency or unit never changes a digit run, so this cannot
 * reject what the token check licenses.
 */
function digitRuns(text: string): Set<string> {
  return new Set(stripOrdinals(text).match(/\p{Nd}+/gu) ?? []);
}

function numericTokenParts(text: string): NumericToken[] {
  const withoutOrdinals = stripOrdinals(text);
  const out: NumericToken[] = [];
  for (const m of withoutOrdinals.matchAll(NUMBER_RE)) {
    if (m[1]) { out.push({ currency: '', number: m[1].toLowerCase(), unit: '' }); continue; }
    const unitRaw = (m[5] ?? m[6] ?? m[7] ?? '').toLowerCase();
    out.push({ currency: m[2] ?? '', number: (m[3] ?? '') + m[4], unit: UNIT_CANON[unitRaw] ?? unitRaw });
  }
  return out;
}

/** Every numeric token in `text`, in full normalised form (currency + number + unit), excluding list ordinals. */
function numericTokens(text: string): string[] {
  return numericTokenParts(text).map(t => t.currency + t.number + t.unit);
}

/**
 * The tokens the prompts stated, widened with the dropped-currency and
 * dropped-unit forms: a stated `$50k` contributes `$50k`, `$50`, `50k` and
 * `50`. Never the reverse — a stated `50k` contributes only `50k` and `50`,
 * so a body inventing `$50k` still fails, as does `5%` against a stated `5`.
 */
function statedNumberTokens(text: string): Set<string> {
  const stated = new Set<string>();
  for (const t of numericTokenParts(text)) {
    for (const currency of t.currency ? [t.currency, ''] : ['']) {
      for (const unit of t.unit ? [t.unit, ''] : ['']) stated.add(currency + t.number + unit);
    }
  }
  return stated;
}

function words(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
}

/**
 * The first run of `COPY_RUN_WORDS` words the body copies verbatim from any
 * excerpt (rule 7, body only), normalised to lower case, or null. Exported so
 * the repair call can name the passage to reword; it goes only to the model,
 * which already saw the excerpt, never into a stored reason.
 */
export function findVerbatimRun(body: string, excerpts: Array<{ text: string }>): string | null {
  return findVerbatimRuns(body, excerpts)[0] ?? null;
}

/**
 * Every copied passage, as maximal runs (overlapping 12-word windows merged),
 * so the repair can name them all: naming only the first left the others in
 * place (localhost). Capped so a wholesale copy cannot flood the
 * repair message.
 */
export function findVerbatimRuns(body: string, excerpts: Array<{ text: string }>, max = 5): string[] {
  const bodyWords = words(body);
  const excerptGrams = new Set<string>();
  for (const e of excerpts) {
    const w = words(e.text);
    for (let i = 0; i + COPY_RUN_WORDS <= w.length; i++) excerptGrams.add(w.slice(i, i + COPY_RUN_WORDS).join(' '));
  }
  const runs: string[] = [];
  let start = -1;
  let end = -1;
  for (let i = 0; i + COPY_RUN_WORDS <= bodyWords.length; i++) {
    if (!excerptGrams.has(bodyWords.slice(i, i + COPY_RUN_WORDS).join(' '))) continue;
    if (start >= 0 && i <= end) { end = i + COPY_RUN_WORDS; continue; }
    if (start >= 0) runs.push(bodyWords.slice(start, end).join(' '));
    start = i;
    end = i + COPY_RUN_WORDS;
  }
  if (start >= 0) runs.push(bodyWords.slice(start, end).join(' '));
  return runs.slice(0, max);
}

function hasVerbatimRun(body: string, excerpts: Array<{ text: string }>): boolean {
  return findVerbatimRun(body, excerpts) !== null;
}

/** The section names (current layout) whose text contains a copied passage. */
function sectionsWithCopies(body: string, excerpts: Array<{ text: string }>): string[] {
  const parts = body.split(/^## /m).slice(1);
  return parts
    .map(p => ({ name: p.slice(0, p.indexOf('\n') < 0 ? p.length : p.indexOf('\n')).trim(), text: p }))
    .filter(p => hasVerbatimRun(p.text, excerpts))
    .map(p => p.name);
}

// `PII_PATTERNS`' email regex (lib/pii/detect.ts) misses real shapes —
// underscore domains (`bob@corp_mail.com`), IP-address domains
// (`bob@10.0.0.1`), single-char TLDs (`bob@host.c`) — so EMAIL_RE is a
// broader fallback checked only when redactPii did NOT already flag the
// text, so a genuine PII-pattern email is reported once, not twice.
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const URL_RE = /https?:\/\/\S+/i;
const PATH_RE = /(?:[A-Za-z]:\\|\/(?:home|users|mnt|tmp|var)\/)\S+/i;
const CITATION_MARKER_RE = /\[\d+(?:\s*,\s*\d+)*\]|excerpt\s*#?\d+/i;

function identityLeaks(text: string): string[] {
  const reasons: string[] = [];
  const redacted = redactPii(text);
  if (redacted !== text) reasons.push('personal data pattern present');
  else if (EMAIL_RE.test(text)) reasons.push('email address present');
  if (URL_RE.test(text)) reasons.push('URL present');
  if (PATH_RE.test(text)) reasons.push('file path present');
  return reasons;
}

/**
 * Case-insensitive, bounded on both sides by a non-word character, so a name
 * never matches inside a longer word (`box` must not match `inbox`) while a
 * hyphen IS a boundary (`Jira-tracked` mentions `jira`). The same regex runs
 * over the body and the corpus.
 */
function boundedNameRe(name: string): RegExp {
  return new RegExp(`(?<!\\w)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w)`, 'i');
}

/**
 * Which telemetry SKILL names rule 6 may check (branch review #2). Skill names
 * seen in telemetry include plain English words (`review`, `run`, `start`,
 * `schedule`, `docs`, `pdf`), and a word-bounded check on those would reject
 * ordinary sentences ("Review the table") on any Code-heavy instance. Only a
 * name carrying a namespace (`:`) or a hyphen is distinctive enough to be read
 * as a system reference; bare single-token skill names are left out.
 * Connector names are NOT passed through this: listKnownSystemNames keeps all
 * of them. Pure.
 */
export function filterCheckableSystemNames(names: string[]): string[] {
  return names.filter(n => n.includes(':') || n.includes('-'));
}

export function validateSkillDraft(raw: RawSkillDraft, corpus: ValidationCorpus, knownSystems: string[]): ValidationResult {
  const reasons: string[] = [];

  if (!isValidSkillName(raw.name)) reasons.push(`skill name "${raw.name}" is not lowercase-kebab-case (1-64 chars)`);
  if (raw.description.length < 1 || raw.description.length > 1024) reasons.push('description must be 1-1024 characters');

  const sectionProblem = checkSections(raw.body);
  if (sectionProblem) reasons.push(sectionProblem);

  // Minor problems: each can be left for the owner, with a note, rather than
  // failing the draft. Citations are metadata (never in the body), so a bad one
  // is dropped, and a section left uncited is flagged.
  const minor: string[] = [];
  const ownerNotes: string[] = [];
  const validIdx = new Set(corpus.excerpts.map(e => e.index));
  const names = sectionNames();
  const citations: Record<string, number[]> = {};
  for (const [section, idxs] of Object.entries(raw.citations)) {
    // A citation for a section the body does not have means nothing; the reply
    // schema rules it out anyway, so it is ignored rather than failed.
    if (!names.includes(section)) continue;
    const kept = idxs.filter(i => validIdx.has(i));
    for (const i of idxs) if (!validIdx.has(i)) minor.push(`citation to excerpt ${i} which does not exist`);
    citations[section] = kept;
  }
  for (const s of MUST_CITE) {
    if (citations[s]?.length) continue;
    minor.push(`section "${s}" cites no excerpt`);
    ownerNotes.push(`The "${s}" section is not linked to the prompts it was drawn from. Check it matches how the team does this work.`);
  }

  // Rule 5 runs on the body AND the description: the description is what ships
  // in the SKILL.md frontmatter and on the S&C Board, so it is the published
  // face of the skill (branch review #3). Description reasons are prefixed.
  const excerptText = corpus.excerpts.map(e => e.text).join('\n');
  const stated = statedNumberTokens(excerptText);
  const statedRuns = digitRuns(excerptText);
  const checkNumbers = (text: string, prefix: string) => {
    const failedRuns = new Set<string>();
    for (const tok of new Set(numericTokens(text))) {
      if (stated.has(tok)) continue;
      reasons.push(`${prefix}number or unit "${tok}" does not appear in the prompts`);
      for (const r of digitRuns(tok)) failedRuns.add(r);
    }
    // Backstop: a second necessary condition. A digit run already reported via a
    // failed token is not reported twice.
    for (const run of digitRuns(text)) {
      if (!statedRuns.has(run) && !failedRuns.has(run)) reasons.push(`${prefix}number "${run}" does not appear in the prompts`);
    }
  };
  checkNumbers(raw.body, '');
  checkNumbers(raw.description, 'description: ');

  // Rule 6. The FULL name is always checked. For a namespaced skill the bare
  // suffix after the last ':' is checked too, but ONLY when that suffix is
  // itself hyphenated (`month-end-variance-commentary`): plugin skills arrive
  // namespaced with plain-word suffixes (`productivity:update`,
  // `anthropic-skills:pdf`, `sales:forecast`), and a single plain word is
  // ordinary English, not a system reference.
  const corpusLc = (excerptText + '\n' + corpus.systems.join('\n')).toLowerCase();
  for (const sys of new Set(knownSystems.map(s => s.toLowerCase()))) {
    const bare = sys.includes(':') ? sys.slice(sys.lastIndexOf(':') + 1) : sys;
    const forms = bare !== sys && bare.includes('-') ? [sys, bare] : [sys];
    const res = forms.map(boundedNameRe);
    const present = res.some(re => re.test(raw.body));
    const inCorpus = res.some(re => re.test(corpusLc));
    if (present && !inCorpus) reasons.push(`system "${sys}" is not in this use case's evidence`);
  }

  if (hasVerbatimRun(raw.body, corpus.excerpts)) {
    minor.push(`body copies a ${COPY_RUN_WORDS}+ word run of a prompt verbatim`);
    // The note names the section, never the copied words: owner questions are
    // stored, and prompt text must not be stored a second time.
    for (const s of sectionsWithCopies(raw.body, corpus.excerpts)) {
      ownerNotes.push(`The "${s}" section repeats someone's prompt word for word. Reword it before downloading.`);
    }
  }
  if (CITATION_MARKER_RE.test(raw.body)) reasons.push('body contains an excerpt citation marker');
  for (const r of identityLeaks(raw.body)) reasons.push(`body: ${r}`);
  for (const r of identityLeaks(raw.description)) reasons.push(`description: ${r}`);

  const cited = new Set(Object.values(citations).flat());
  const thin = corpus.distinctPrompts > 0 && cited.size / corpus.distinctPrompts < THIN_COVERAGE;
  const draft = (notes: string[]): ValidatedSkillDraft => ({
    name: raw.name,
    description: raw.description,
    body: raw.body,
    ownerQuestions: [...notes, ...raw.ownerQuestions.map(q => redactPii(q.trim())).filter(Boolean)],
    citations,
    thin,
  });

  if (reasons.length) return { ok: false, reasons: [...reasons, ...minor] };
  if (minor.length) return { ok: false, reasons: minor, fallback: draft(ownerNotes) };
  return { ok: true, draft: draft([]) };
}

/** Rules 2, 3 and 8 only — the owner may add numbers, units and systems they are accountable for. */
export function validateEdit(patch: { skillName?: string; description?: string; bodyMd?: string }): string[] {
  const reasons: string[] = [];
  if (patch.skillName !== undefined && !isValidSkillName(patch.skillName)) reasons.push('skill name must be lowercase letters, digits and single hyphens, 1-64 characters');
  if (patch.description !== undefined && (patch.description.trim().length < 1 || patch.description.length > 1024)) reasons.push('description must be 1-1024 characters');
  if (patch.bodyMd !== undefined) {
    const s = checkSections(patch.bodyMd, true);
    if (s) reasons.push(s);
    for (const r of identityLeaks(patch.bodyMd)) reasons.push(`body: ${r}`);
  }
  if (patch.description !== undefined) for (const r of identityLeaks(patch.description)) reasons.push(`description: ${r}`);
  return reasons;
}

export function sectionCitationCounts(body: string, citations: Record<string, number[]>): Array<{ section: string; count: number }> {
  return sectionNames(layoutOf(body)).map(section => ({ section, count: new Set(citations[section] ?? []).size }));
}
