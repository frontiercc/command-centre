// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import {
  SKILL_SECTIONS, LEGACY_SKILL_SECTIONS, sanitiseJson, parseRawDraft, isValidSkillName, validateSkillDraft, validateEdit, sectionCitationCounts,
  filterCheckableSystemNames,
  type RawSkillDraft, type ValidationCorpus,
} from '@/lib/usecases/skill-draft-validate';

const corpus: ValidationCorpus = {
  excerpts: [
    { index: 0, text: 'here are the rows from the management accounts, draft the month-end variance commentary. flag anything more than 5% or 50k off budget' },
    { index: 1, text: 'no - one paragraph per line item, board tone, no bullet points' },
    { index: 2, text: 'check the revenue number against salesforce closed-won before you write anything' },
    { index: 3, text: 'unrelated - book me a room for tuesday' },
  ],
  distinctPrompts: 4,
  systems: ['salesforce', 'anthropic-skills:xlsx'],
};
const known = ['salesforce', 'anthropic-skills:xlsx', 'jira', 'hubspot'];

function body(over: Partial<Record<string, string>> = {}): string {
  const parts: Record<string, string> = {
    '## Purpose': 'Produce the monthly variance commentary for the board pack.',
    '## When to use this skill': 'When a user asks for "variance commentary" for a close period.',
    '## What to ask for before starting': 'The management accounts rows and the period.',
    '## Steps': '1. Build the variance table.\n2. Tie revenue to Salesforce closed-won before writing.\n3. Flag lines over 5% or 50k.',
    '## Output format': 'A table, then one paragraph per flagged line.',
    '## Quality rules': 'One paragraph per line. Board tone. No bullet points.',
    '## Edge cases': 'Revenue does not tie: stop and flag.',
    '## Not part of this skill': 'Room bookings and other admin requests.',
    ...over,
  };
  return SKILL_SECTIONS.map(h => `${h}\n${parts[h]}`).join('\n\n');
}
const good: RawSkillDraft = {
  name: 'month-end-variance-commentary',
  description: 'Drafts board-pack variance commentary from management accounts rows. Use when someone asks for month-end variance commentary.',
  body: body(),
  ownerQuestions: ['Is the threshold 5% or 50k or both?'],
  citations: { 'Purpose': [0], 'When to use this skill': [0], 'What to ask for before starting': [0], 'Steps': [0, 2], 'Output format': [1], 'Quality rules': [1], 'Edge cases': [2], 'Not part of this skill': [3] },
  excludedExcerpts: [3],
};

describe('sanitiseJson + parseRawDraft', () => {
  it('escapes a raw newline inside a JSON string and leaves whitespace between tokens alone', () => {
    const src = '{\n  "name": "a-b",\n  "body": "line one\nline two"\n}';
    expect(() => JSON.parse(src)).toThrow();
    expect(JSON.parse(sanitiseJson(src))).toEqual({ name: 'a-b', body: 'line one\nline two' });
  });
  it('strips code fences and returns null on junk', () => {
    expect(parseRawDraft('```json\n' + JSON.stringify(good) + '\n```')).toEqual(good);
    expect(parseRawDraft('not json')).toBeNull();
  });
});

describe('isValidSkillName', () => {
  it.each([['month-end', true], ['a1', true], ['-lead', false], ['double--hyphen', false], ['Upper', false], ['x'.repeat(65), false], ['', false]])('%s → %s', (n, ok) => {
    expect(isValidSkillName(n)).toBe(ok);
  });
});

describe('validateSkillDraft', () => {
  it('accepts the good draft, not thin', () => {
    const r = validateSkillDraft(good, corpus, known);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.draft.thin).toBe(false); expect(r.draft.name).toBe(good.name); }
  });
  it('rejects a bad name and a missing section', () => {
    expect(validateSkillDraft({ ...good, name: 'Bad Name' }, corpus, known)).toMatchObject({ ok: false, reasons: [expect.stringMatching(/name/)] });
    const r = validateSkillDraft({ ...good, body: good.body.replace('## Edge cases', '## Edges') }, corpus, known);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join(' ')).toMatch(/Edge cases/);
  });
  it('rejects a citation to an excerpt that does not exist, and Steps/Quality rules with no citation', () => {
    expect(validateSkillDraft({ ...good, citations: { ...good.citations, 'Steps': [0, 9] } }, corpus, known).ok).toBe(false);
    expect(validateSkillDraft({ ...good, citations: { ...good.citations, 'Quality rules': [] } }, corpus, known).ok).toBe(false);
  });
  it('rejects a number, a currency and a unit the excerpts never stated', () => {
    expect(validateSkillDraft({ ...good, body: body({ '## Steps': '1. Flag lines over 7%.' }) }, corpus, known).ok).toBe(false);
    expect(validateSkillDraft({ ...good, body: body({ '## Steps': '1. Flag lines over $50k.' }) }, corpus, known).ok).toBe(false);   // $ never stated
    expect(validateSkillDraft({ ...good, body: body({ '## Steps': '1. Wait 2 hours.' }) }, corpus, known).ok).toBe(false);
    expect(validateSkillDraft({ ...good, body: body({ '## Steps': '1. Flag lines over 5% or 50k.\n2. Tie revenue.' }) }, corpus, known).ok).toBe(true); // stated, and list ordinals are fine
  });
  it('lets the body drop a unit the prompts stated, but never add a currency they did not', () => {
    // "flag anything over 50" invents nothing — the prompts stated 50k, and a
    // unit-bearing stated number licenses its own bare form.
    expect(validateSkillDraft({ ...good, body: body({ '## Steps': '1. Flag anything over 50.' }) }, corpus, known).ok).toBe(true);
    // but the reverse never holds: a bare stated number does not license the
    // body attaching a currency symbol the prompts never priced.
    expect(validateSkillDraft({ ...good, body: body({ '## Steps': '1. Flag anything over $50k.' }) }, corpus, known).ok).toBe(false);
  });
  it('recognises hyphenated, glued and ranged numeric shapes the excerpts state, and rejects them when absent', () => {
    const withHours = { ...corpus, excerpts: [...corpus.excerpts, { index: 4, text: 'respond to any escalation within 48h of receipt' }] };
    expect(validateSkillDraft({ ...good, body: body({ '## Steps': '1. Respond within 48h.' }) }, corpus, known).ok).toBe(false);
    expect(validateSkillDraft({ ...good, body: body({ '## Steps': '1. Respond within 48h.' }) }, withHours, known).ok).toBe(true);

    const withDay = { ...corpus, excerpts: [...corpus.excerpts, { index: 4, text: 'this needs a 5-day turnaround from the team' }] };
    expect(validateSkillDraft({ ...good, body: body({ '## Steps': '1. Plan for a 5-day turnaround.' }) }, corpus, known).ok).toBe(false);
    expect(validateSkillDraft({ ...good, body: body({ '## Steps': '1. Plan for a 5-day turnaround.' }) }, withDay, known).ok).toBe(true);

    const withRange = { ...corpus, excerpts: [...corpus.excerpts, { index: 4, text: 'flag anything in the 10-15% range as a swing line' }] };
    expect(validateSkillDraft({ ...good, body: body({ '## Steps': '1. Flag 10-15% moves.' }) }, corpus, known).ok).toBe(false);
    expect(validateSkillDraft({ ...good, body: body({ '## Steps': '1. Flag 10-15% moves.' }) }, withRange, known).ok).toBe(true);

    const withMultiple = { ...corpus, excerpts: [...corpus.excerpts, { index: 4, text: 'we want roughly a 2x uplift on last quarter' }] };
    expect(validateSkillDraft({ ...good, body: body({ '## Steps': '1. Aim for a 2x uplift.' }) }, corpus, known).ok).toBe(false);
    expect(validateSkillDraft({ ...good, body: body({ '## Steps': '1. Aim for a 2x uplift.' }) }, withMultiple, known).ok).toBe(true);
  });
  describe('rule 5 tokeniser: one token = number + attached currency + attached unit', () => {
    const steps = (t: string) => ({ ...good, body: body({ '## Steps': t }) });
    const plus = (text: string): ValidationCorpus => ({ ...corpus, excerpts: [...corpus.excerpts, { index: 4, text }] });
    const ok = (t: string, c: ValidationCorpus = corpus) => validateSkillDraft(steps(t), c, known).ok;

    it('glued unit: 48h fails when absent, passes against 48h and against 48 h', () => {
      expect(ok('1. Respond within 48h.')).toBe(false);
      expect(ok('1. Respond within 48h.', plus('reply within 48h please'))).toBe(true);
      expect(ok('1. Respond within 48h.', plus('reply within 48 h please'))).toBe(true);
    });
    it('hyphen or space joined unit: 5-day fails when absent, passes against 5 day and 5-day', () => {
      expect(ok('1. Plan for a 5-day turnaround.')).toBe(false);
      expect(ok('1. Plan for a 5-day turnaround.', plus('we need a 5 day turnaround'))).toBe(true);
      expect(ok('1. Plan for a 5-day turnaround.', plus('we need a 5-day turnaround'))).toBe(true);
    });
    it('the word after a number is not a unit unless it is on the unit allowlist', () => {
      expect(ok('1. Write 3 short paragraphs.', plus('give me 3 paragraphs'))).toBe(true);
      expect(ok('1. Flag over 50 lines.')).toBe(true);               // stated 50k, unit dropped, next word ignored
    });
    it('letter-prefixed numbers are tokens: an invented Q4 fails, a stated Q3 passes', () => {
      const q3 = plus('pull the Q3 numbers from the pack');
      expect(ok('1. Compare the Q4 numbers.', q3)).toBe(false);
      expect(ok('1. Compare the Q3 numbers.', q3)).toBe(true);
      expect(ok('1. Compare the FY25 numbers.', q3)).toBe(false);
    });
    it('the body may drop a stated currency or unit but never add one', () => {
      const priced = { ...corpus, excerpts: [{ index: 0, text: 'flag anything more than $50k off budget, or 5 points' }, ...corpus.excerpts.slice(1)] };
      expect(ok('1. Flag lines over 50k.', priced)).toBe(true);    // dropped currency
      expect(ok('1. Flag lines over 50.', priced)).toBe(true);     // dropped currency and unit
      expect(ok('1. Flag lines over $50.', priced)).toBe(true);    // dropped unit
      expect(ok('1. Flag lines over $50k.', priced)).toBe(true);
      expect(ok('1. Flag lines over $50k.')).toBe(false);          // stated only 50k: added currency
      expect(ok('1. Flag lines over 5%.', priced)).toBe(false);    // stated only 5: added unit
    });
    it('a range is two tokens, the unit attaching to the second number only (10-15% -> 10, 15%)', () => {
      const range = plus('flag anything in the 10-15% range');
      expect(ok('1. Flag 10-15% moves.')).toBe(false);
      expect(ok('1. Flag 10-15% moves.', range)).toBe(true);
      expect(ok('1. Flag 10-15% moves.', plus('flag 10 or 15% moves'))).toBe(true);
      expect(ok('1. Flag 10-20% moves.', range)).toBe(false);      // 20% invented
      expect(ok('1. Flag 15% moves.', range)).toBe(true);
      expect(ok('1. Flag 10% moves.', range)).toBe(false);         // the % was attached to 15, not 10
    });
    // A corpus with no "5%" in it, so a body "5 percent" can only pass on what these excerpts say.
    const only = (text: string): ValidationCorpus => ({ ...corpus, excerpts: [{ index: 0, text }, ...corpus.excerpts.slice(1)] });
    it('seconds and percent are unit words: a body cannot swap the unit the prompts stated', () => {
      expect(ok('1. Wait 5 seconds.', only('wait 5 minutes then flag anything over 50k'))).toBe(false);
      expect(ok('1. Flag 5 percent moves.', only('flag anything 5 points or 50k off'))).toBe(false);
      expect(ok('1. Flag 5 percent moves.', only('flag anything 5% or 50k off'))).toBe(true);
      expect(ok('1. Wait 5 secs.', only('wait 5 seconds then flag anything over 50k'))).toBe(true);
    });
    it('letters glued around digits are tokenised: Q4s, Sprint42 and week52', () => {
      expect(ok('1. Compare the Q4s.', plus('pull the Q3 numbers'))).toBe(false);
      expect(ok('1. Close out Sprint42.', plus('close out Sprint 41'))).toBe(false);
      expect(ok('1. Plan week52.', plus('plan week52 carefully'))).toBe(true);
    });
    it('trailing letters on a prefixed identifier are not a number: v2beta passes against v2', () => {
      expect(ok('1. Use the v2beta template.', plus('use the v2 template'))).toBe(true);
      expect(ok('1. Use the v3beta template.', plus('use the v2 template'))).toBe(false);
    });
    it('digit-run backstop: digits in a shape the tokeniser does not read still have to be stated', () => {
      const r = validateSkillDraft(steps('1. Open ticket_123 first.'), corpus, known);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reasons).toContain('number "123" does not appear in the prompts');
      expect(ok('1. Open ticket_123 first.', plus('open ticket 123 first'))).toBe(true);
      expect(ok('1. Flag 5_000 moves.')).toBe(false);              // 5 stated, 000 never was
    });
  });
  it('treats a hyphen as a word boundary for system names, but not a letter', () => {
    expect(validateSkillDraft({ ...good, body: body({ '## Steps': '1. Update the Jira-tracked tickets.' }) }, corpus, known).ok).toBe(false);
    expect(validateSkillDraft({ ...good, body: body({ '## Steps': '1. Check the inbox before starting.' }) }, corpus, [...known, 'box']).ok).toBe(true);
  });
  it('rejects a known system the corpus never touched, allows one it did', () => {
    expect(validateSkillDraft({ ...good, body: body({ '## Steps': '1. Pull the tickets from Jira.' }) }, corpus, known).ok).toBe(false);
    expect(validateSkillDraft({ ...good, body: body({ '## Steps': '1. Tie revenue to Salesforce closed-won.' }) }, corpus, known).ok).toBe(true);
  });
  it('ordinary English that happens to be a bare skill name is not a system once the list is filtered (branch review #2)', () => {
    const reviewBody = { ...good, body: body({ '## Steps': '1. Review the table before writing.' }) };
    // Unfiltered, a bare telemetry skill called "review" would reject plain English.
    expect(validateSkillDraft(reviewBody, corpus, ['review']).ok).toBe(false);
    // listKnownSystemNames filters skill names this way, then adds connectors unfiltered.
    const checkable = [...filterCheckableSystemNames(['review', 'jira', 'anthropic-skills:xlsx']), 'jira'];
    expect(validateSkillDraft(reviewBody, corpus, checkable).ok).toBe(true);
    expect(validateSkillDraft({ ...good, body: body({ '## Steps': '1. Pull the tickets from Jira.' }) }, corpus, checkable).ok).toBe(false);
  });
  it('checks a namespaced skill by its FULL name; the bare suffix only when the suffix itself is hyphenated', () => {
    const ns = ['anthropic-skills:pdf', 'productivity:update', 'acme-library:month-end-variance-commentary'];
    const steps = (t: string) => ({ ...good, body: body({ '## Steps': t }) });
    // Single plain-word suffixes ("pdf", "update") are ordinary English, never a system reference.
    expect(validateSkillDraft(steps('1. Update the PDF export.'), corpus, ns).ok).toBe(true);
    // A hyphenated suffix is distinctive, so it is still checked on its own.
    const hy = validateSkillDraft(steps('1. Run month-end-variance-commentary.'), corpus, ns);
    expect(hy.ok).toBe(false);
    if (!hy.ok) expect(hy.reasons).toContain(`system "acme-library:month-end-variance-commentary" is not in this use case's evidence`);
    // The full namespaced name is always checked.
    const full = validateSkillDraft(steps('1. Run anthropic-skills:pdf on the pack.'), corpus, ns);
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.reasons).toContain(`system "anthropic-skills:pdf" is not in this use case's evidence`);
  });
  it('rule 5 covers the description too: an invented number there fails, a stated one passes (branch review #3)', () => {
    const r = validateSkillDraft({ ...good, description: 'Drafts variance commentary and cuts close time by 12%. Use for month-end variance commentary.' }, corpus, known);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasons).toContain('description: number or unit "12%" does not appear in the prompts');
      expect(r.reasons.some(x => x.startsWith('description:'))).toBe(true);
    }
    const bare = validateSkillDraft({ ...good, description: 'Drafts variance commentary, ref ticket_77. Use for month-end variance commentary.' }, corpus, known);
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.reasons).toContain('description: number "77" does not appear in the prompts');
    expect(validateSkillDraft({ ...good, description: 'Flags lines over 5% or 50k in month-end variance commentary.' }, corpus, known).ok).toBe(true);
  });
  it('rejects a 12+ word verbatim copy of an excerpt in the body but not in the description', () => {
    const copy = 'here are the rows from the management accounts, draft the month-end variance commentary. flag anything';
    expect(validateSkillDraft({ ...good, body: body({ '## Purpose': copy }) }, corpus, known).ok).toBe(false);
    expect(validateSkillDraft({ ...good, description: copy }, corpus, known).ok).toBe(true);
  });
  it('treats a copied passage as minor: a fallback draft with a note naming the section, never the copied words', () => {
    const copy = 'here are the rows from the management accounts, draft the month-end variance commentary. flag anything';
    const r = validateSkillDraft({ ...good, body: body({ '## Purpose': copy }) }, corpus, known);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.fallback).toBeDefined();
    expect(r.fallback!.ownerQuestions[0]).toBe('The "Purpose" section repeats someone\'s prompt word for word. Reword it before downloading.');
    expect(r.fallback!.ownerQuestions.join(' ')).not.toContain('management accounts');
  });
  it('gives no fallback when a blocking rule fails alongside a minor one', () => {
    const r = validateSkillDraft({ ...good, body: body({ '## Steps': '1. Flag lines over 70k.' }), citations: { ...good.citations, 'Steps': [] } }, corpus, known);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fallback).toBeUndefined();
  });
  it('rejects a body that still carries an email or a citation marker', () => {
    expect(validateSkillDraft({ ...good, body: body({ '## Steps': '1. Send to james.l@example.com.' }) }, corpus, known).ok).toBe(false);
    expect(validateSkillDraft({ ...good, body: body({ '## Quality rules': 'One paragraph per line (from excerpt [1]).' }) }, corpus, known).ok).toBe(false);
  });
  it('rejects email shapes redactPii itself misses (underscore domain, IP domain, single-char TLD)', () => {
    expect(validateSkillDraft({ ...good, body: body({ '## Steps': '1. Send to bob@corp_mail.com.' }) }, corpus, known).ok).toBe(false);
    expect(validateSkillDraft({ ...good, body: body({ '## Steps': '1. Send to bob@10.0.0.1.' }) }, corpus, known).ok).toBe(false);
    expect(validateSkillDraft({ ...good, body: body({ '## Steps': '1. Send to bob@host.c.' }) }, corpus, known).ok).toBe(false);
  });
  it('reports out-of-order sections distinctly from missing ones', () => {
    const parts = body().split('\n\n');
    const reordered = [parts[1], parts[0], ...parts.slice(2)].join('\n\n');
    const r = validateSkillDraft({ ...good, body: reordered }, corpus, known);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join(' ')).toMatch(/out of order/);
  });
  it('flags thin when fewer than a quarter of distinct prompts are cited', () => {
    const r = validateSkillDraft({ ...good, citations: Object.fromEntries(Object.keys(good.citations).map(k => [k, [0]])) }, { ...corpus, distinctPrompts: 8 }, known);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.draft.thin).toBe(true);
  });
});

describe('filterCheckableSystemNames', () => {
  it('keeps only skill names carrying a namespace or hyphen; bare single-token names are dropped', () => {
    expect(filterCheckableSystemNames(['review', 'run', 'start', 'schedule', 'docs', 'pdf', 'jira', 'anthropic-skills:xlsx', 'month-end-variance', 'mkt:thing']))
      .toEqual(['anthropic-skills:xlsx', 'month-end-variance', 'mkt:thing']);
  });
});

describe('validateEdit', () => {
  it('checks name, sections and identity leaks only — an owner may add numbers', () => {
    expect(validateEdit({ skillName: 'Bad' })).toHaveLength(1);
    expect(validateEdit({ bodyMd: '## Purpose\nx' })).toHaveLength(1);           // missing sections
    expect(validateEdit({ bodyMd: body({ '## Steps': '1. Wait 2 hours, then email bob@x.com.' }) })).toHaveLength(1); // email, not the number
    expect(validateEdit({ description: 'fine', bodyMd: body() })).toEqual([]);
  });
  it('keeps a draft written in the old eight-section layout editable, but a generated draft must use the current one', () => {
    const legacy = LEGACY_SKILL_SECTIONS.map(h => `${h}\nText.`).join('\n\n');
    expect(validateEdit({ bodyMd: legacy })).toEqual([]);
    expect(validateSkillDraft({ ...good, body: legacy }, corpus, known).ok).toBe(false);
    expect(sectionCitationCounts(legacy, good.citations).map(r => r.section)).toContain('When to use this skill');
    expect(SKILL_SECTIONS).not.toContain('## When to use this skill');
  });
});

describe('sectionCitationCounts', () => {
  it('returns one row per section in order with its citation count', () => {
    const rows = sectionCitationCounts(good.body, good.citations);
    expect(rows.map(r => r.section)).toEqual(SKILL_SECTIONS.map(h => h.replace(/^## /, '')));
    expect(rows.find(r => r.section === 'Steps')?.count).toBe(2);
  });
});
