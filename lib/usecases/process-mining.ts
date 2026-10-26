// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Department process mining (Department Process Transformation).
 *
 * One grounded Claude call per department corpus that clears a
 * pre-LLM materiality screen, validated into process candidates,
 * enriched with measured session facts, and upserted as a department-scoped
 * open suggestion. The model only names/describes a process and
 * cites which excerpts show it — every count on the stored canvas/evidence
 * comes from the corpus and cited excerpts, never from the model's own words
 * (validateProcessCandidates already strips any digit-bearing field).
 *
 * Cadence-gated scheduler job (the retired emergent-suggestion job's shape),
 * queueAiCall usage,
 * extractText/stripCodeFences parsing, never-throws on any LLM failure path.
 */
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient } from '@/lib/anthropic/client';
import { getAllConfig, getConfigValue, setConfigValue } from '@/lib/config';
import { extractText, stripCodeFences } from '@/lib/anthropic/constants';
import { thinkingOff } from '@/lib/anthropic/thinking';
import { queueAiCall } from '@/lib/ingestion/scheduler';
import { ACROSS_DEPARTMENTS, gatherDeptCorpora, gatherSessionFacts, sampleAcrossDepartments, type MinedSurface } from '@/lib/usecases/process-corpus';
import { formatClues } from '@/lib/usecases/prompt-text';
import {
  DEFAULT_PROCESS_DENYLIST, DEFAULT_RULE_SIGNAL_TRIM, buildSignalTrimSet, computeProcessKey, excludedKind,
  overlapsResolved, rhythmLabel, tierNoteFor, trimCommoditySignals, validateProcessCandidates,
} from '@/lib/usecases/process-validate';
import {
  countOpenAcrossDepartments, countOpenByDepartment, getSuggestionBySignalKey, listAcrossSuggestionTitles, listResolvedDepartmentTitles, listSuggestionTitlesByDepartment,
  resolvedSessionSets, resolvedSignalKeys, upsertOpenSuggestion,
} from '@/lib/usecases/suggestion-store';
import type { DeptCorpus } from '@/lib/usecases/process-corpus';
import type { QualBar, ValidProcessCandidate } from '@/lib/usecases/process-validate';
import type { ProcessCanvas } from '@/lib/usecases/suggestion-store';

export const SYSTEM_PROMPT = `You identify the recurring BUSINESS PROCESSES a department hands to its AI assistant, from numbered excerpts of that department's real prompts.
A process is a specific job the department repeats, done the same way each time, that produces a named output ("month-end variance commentary", "client billing pack assembly", "weekly timesheet chase list"). Only suggest work like that. Never suggest a general activity (building or editing slides and decks, writing code, research, finding or retrieving documents, drafting documents, answering questions as they come up), personal development (career plans, exam or certification study), or a one-off project, however many sessions it took.
Where an excerpt shows its session's files uploaded, files made or connector actions, use them as clues to what the work takes in and produces.
Describe what the work is about and what it produces. Never describe a process by how it runs: being scheduled, automated, run without the user present or done with a particular tool is not what the work is.
For each distinct process you can actually see in the excerpts, return:
- "title": the process, a few plain words, no numbers
- "story": 2-4 sentences on what this work is, what it produces and how it appears to be done today, and what changes if the department transforms it, drawn ONLY from the excerpts; no numbers, no names, no companies, no quoted text
- "valueHypothesis": one sentence, in words only, no numbers
- "keywords": 2-4 short phrases from the excerpts showing how people describe this work
- "excerptIndices": the excerpt numbers that show this process; cite ONLY excerpts that genuinely show it
If the excerpts show no genuine recurring process, return an empty list. Fewer, better: never pad.
If a candidate matches an already-proposed process in meaning, omit it.`;

/**
 * The cross-department pass: the same rules, read across
 * departments, keeping only work people in at least two departments do the
 * same way. Excerpts carry their department.
 */
export const ACROSS_SYSTEM_PROMPT = SYSTEM_PROMPT
  .replace("a department hands to its AI assistant, from numbered excerpts of that department's real prompts.",
    'people in several departments hand to their AI assistant, from numbered excerpts of real prompts, each marked with its department.')
  .replace('A process is a specific job the department repeats', 'A process is a specific job people repeat')
  + '\nOnly suggest a process that people in at least two different departments do the same way, producing the same kind of named output, and cite excerpts from each of those departments. Shared work counts when people in different departments produce the same kind of output for the same purpose (for example client proposal decks, weekly status reports, morning briefings); a bare activity with no shared purpose, such as editing slides or finding a file, does not.';

/** Cross-department reads per mining run, and how many cross-department suggestions may be open at once (aim for about ten). */
export const ACROSS_READS = 4;
export const ACROSS_MAX_OPEN = 10;

/** The reply's fixed shape (output_config), so a reply can never be prose. */
export const PROCESS_SCHEMA = {
  type: 'object',
  properties: {
    processes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          story: { type: 'string' },
          valueHypothesis: { type: 'string' },
          keywords: { type: 'array', items: { type: 'string' } },
          excerptIndices: { type: 'array', items: { type: 'integer' } },
        },
        required: ['title', 'story', 'valueHypothesis', 'keywords', 'excerptIndices'],
        additionalProperties: false,
      },
    },
  },
  required: ['processes'],
  additionalProperties: false,
} as const;

/** Thinking off and this cap: Sonnet 5's thinking counts against max_tokens, and a cut-off reply used to return no suggestions silently. */
export const MINING_MAX_TOKENS = 4000;


/** parseInt with a `||`-default + a >=1 numeric guard — mirrors
 *  lib/usecases/tracker.ts's runUseCaseTrackerJob cadence parsing. */
function intOr(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw || String(fallback), 10);
  return isFinite(n) && n >= 1 ? n : fallback;
}

function parseDenylist(raw: string | undefined): string[] {
  if (!raw) return DEFAULT_PROCESS_DENYLIST;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x): x is string => typeof x === 'string')) return parsed;
  } catch {
    // fall through to default
  }
  return DEFAULT_PROCESS_DENYLIST;
}

/** Default for useCasesSuggestExcludedSignals when the config key is unset
 *  or unreadable. Must agree with the config key's documented default. */
const DEFAULT_EXCLUDED_SIGNALS_FALLBACK = ['anthropic-skills:docx', 'anthropic-skills:pptx', 'basic_drafting', 'transcription'];

function parseExcludedSignals(raw: string | undefined): string[] {
  if (!raw) return DEFAULT_EXCLUDED_SIGNALS_FALLBACK;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x): x is string => typeof x === 'string')) return parsed;
  } catch {
    // fall through to default
  }
  return DEFAULT_EXCLUDED_SIGNALS_FALLBACK;
}

/**
 * The numbered excerpts, each session's clues (files uploaded and made,
 * connector actions) shown once, on its first excerpt. Pure, for tests.
 */
export function buildMiningExcerpts(corpus: DeptCorpus): string {
  const shown = new Set<string>();
  return corpus.excerpts.map(e => {
    let line = `Excerpt ${e.index}${e.department ? ` (${e.department})` : ''}: ${JSON.stringify(e.text)}`;
    if (!shown.has(e.sessionId)) {
      shown.add(e.sessionId);
      const clue = formatClues(corpus.clues?.[e.sessionId]);
      if (clue) line += ` [its session: ${clue}]`;
    }
    return line;
  }).join('\n');
}

/**
 * One Claude call synthesising process candidates from a single department's
 * excerpt corpus. Never throws — every failure path (no excerpts, no API key,
 * a failed call, unparsable JSON) returns []. The user message is nothing but
 * the numbered excerpts; no org grounding is sent (dept corpora only).
 */
export async function synthesiseDeptProcesses(
  corpus: DeptCorpus,
  denylist: string[],
  bar: QualBar,
  /** Told why a department produced nothing when that was a failure (call error, cut-off or unreadable reply), not "no process found". */
  onFailure?: (reason: string) => void,
): Promise<ValidProcessCandidate[]> {
  if (corpus.excerpts.length === 0) return [];
  const apiKey = await getConfigValue('anthropicAiApiKey');
  if (!apiKey) return [];
  const model = (await getConfigValue('processMiningModel'))
    || (await getConfigValue('useCasesIdeateModel'))
    || 'claude-sonnet-5';

  let userMsg = buildMiningExcerpts(corpus);

  // Prior-titles dedup — every title ever proposed for this
  // department, across ALL statuses, so the model never re-proposes an
  // already-dismissed/added/open process under a reworded name.
  // The cross-department pass runs first and is told only its own earlier
  // titles; a department pass is told its own and every cross-department
  // title, so work done in several departments is claimed once, across them.
  const across = corpus.department === ACROSS_DEPARTMENTS;
  const priorTitles = across
    ? [...await listAcrossSuggestionTitles(), ...await listResolvedDepartmentTitles()]
    : [...await listSuggestionTitlesByDepartment(corpus.department), ...await listAcrossSuggestionTitles()];
  if (priorTitles.length > 0) {
    userMsg += `\nAlready proposed${across ? '' : ' for this department'} (do NOT re-propose these processes, even reworded): ${priorTitles.map(t => JSON.stringify(t)).join(', ')}`;
  }

  let message: Anthropic.Message;
  try {
    const client = createAnthropicClient(apiKey);
    const off = thinkingOff(model);
    message = await queueAiCall(() => client.messages.create({
      model, max_tokens: MINING_MAX_TOKENS, system: across ? ACROSS_SYSTEM_PROMPT : SYSTEM_PROMPT, messages: [{ role: 'user', content: userMsg }],
      output_config: { format: { type: 'json_schema', schema: PROCESS_SCHEMA }, ...(off.effort ? { effort: off.effort } : {}) },
      ...(off.thinking ? { thinking: off.thinking } : {}),
    }));
  } catch (err) {
    onFailure?.(`${corpus.department}: model call failed (${err instanceof Error ? err.message : String(err)})`);
    return [];
  }

  if (message.stop_reason === 'max_tokens') {
    onFailure?.(`${corpus.department}: reply cut off at ${MINING_MAX_TOKENS} tokens`);
    return [];
  }
  let parsed: unknown;
  try {
    const obj = JSON.parse(stripCodeFences(extractText(message))) as { processes?: unknown } | unknown[];
    // The schema returns { processes: [...] }; a bare array is still accepted.
    parsed = Array.isArray(obj) ? obj : (obj as { processes?: unknown }).processes;
  } catch {
    onFailure?.(`${corpus.department}: unreadable reply`);
    return [];
  }

  // Why proposals were left out, as counts by reason (no titles: they are drawn from prompts).
  const reasons = new Map<string, number>();
  const kept = validateProcessCandidates(parsed, corpus.excerpts, denylist, bar, (_t, reason) => {
    const r = reason.replace(/\s*\(.*\)$/, '');
    reasons.set(r, (reasons.get(r) ?? 0) + 1);
  }).filter(c => {
    // Kinds of work never suggested, checked in code: the prompt's
    // instruction alone did not hold. Slide work only in department suggestions.
    const kind = excludedKind(c.title, !across);
    if (kind) reasons.set(kind, (reasons.get(kind) ?? 0) + 1);
    return !kind;
  });
  if (reasons.size > 0) {
    console.log(`[ProcessMining] ${corpus.department}: kept ${kept.length}; left out ${[...reasons].map(([r, n]) => `${n} ${r}`).join(', ')}`);
  }
  return kept;
}

/**
 * Scheduled mining job: for each department corpus that clears a pre-LLM
 * materiality screen (the corpus itself must be able to clear the bar before
 * any LLM call is spent on it), synthesises process candidates and upserts
 * each survivor as an open, department-scoped suggestion. Gated on
 * useCasesEnabled + useCasesSuggestUseContent (the one switch for every use
 * case feature that reads prompt content) + a configurable cadence
 * (skippable with force). The per-dept open-suggestion cap only blocks a
 * BRAND NEW signal_key — a candidate matching an existing open row always
 * refreshes regardless of how many other open rows that department carries.
 */
export async function runProcessMiningJob(
  opts?: { force?: boolean; nowS?: number },
): Promise<{ generated: number; departments: number }> {
  if ((await getConfigValue('useCasesEnabled')) !== 'true') return { generated: 0, departments: 0 };
  const cfg = await getAllConfig();
  if (cfg.useCasesSuggestUseContent !== 'true') return { generated: 0, departments: 0 };

  const nowS = opts?.nowS ?? Math.floor(Date.now() / 1000);
  if (!opts?.force) {
    const intervalDays = intOr(cfg.processMiningIntervalDays, 7);
    const last = await getConfigValue('processMiningLastRun');
    if (last && parseInt(last, 10) > nowS - intervalDays * 86400) return { generated: 0, departments: 0 };
  }

  const windowDays = intOr(cfg.processMiningWindowDays, 28);
  // At least two people for every suggestion: no one-person
  // route. Cross-department suggestions also need two departments.
  const minUsers = Math.max(2, intOr(cfg.processMiningMinUsers, 2));
  const deptBar: QualBar = { minUsers };
  const acrossBar: QualBar = { minUsers, minDepartments: 2 };
  const maxOpen = intOr(cfg.processMiningMaxOpenPerDept, 5);
  const denylist = parseDenylist(cfg.processMiningDenylist);
  const resolved = await resolvedSignalKeys();
  const resolvedSessions = await resolvedSessionSets();
  /** Big departments (3 or more reads on either surface) have no cap on open suggestions. */
  const uncapped = new Set<string>();

  // Commodity trim for the STORED MATCHING RULE only (skills and
  // connectors stay on the rule; only the obvious commodity ones are trimmed).
  // canvas.systems keeps the full untrimmed list: observed facts stay honest.
  const ruleTrimSet = buildSignalTrimSet([
    ...DEFAULT_RULE_SIGNAL_TRIM,
    ...parseExcludedSignals(cfg.useCasesSuggestExcludedSignals),
  ]);

  let generated = 0;
  let departments = 0;
  const failures: string[] = [];

  /** Stores one validated candidate; a null department means cross-department. */
  const store = async (c: ValidProcessCandidate, department: string | null, surface: MinedSurface): Promise<void> => {
    const signalKey = computeProcessKey(department ?? ACROSS_DEPARTMENTS, c.title);
    if (resolved.has(signalKey)) return; // dismissed/added never returns
    const existing = await getSuggestionBySignalKey(signalKey);
    // The same work reworded: mostly the sessions behind one a person dismissed or added.
    if (!existing && overlapsResolved(c.citedSessions, resolvedSessions)) return;
    if (!existing && !(department && uncapped.has(department))) {
      const open = department ? await countOpenByDepartment(department) : await countOpenAcrossDepartments();
      if (open >= (department ? maxOpen : ACROSS_MAX_OPEN)) return;
    }

    const depts = department ? [department] : c.citedDepartments;
    const facts = await gatherSessionFacts(c.citedSessions);
    const canvas: ProcessCanvas = {
      story: c.story,
      valueHypothesis: c.valueHypothesis,
      ...(department ? {} : { departments: depts }),
      people: c.citedUsers.length,
      sessions: c.citedSessions.length,
      occasions: c.citedDays,
      windowDays,
      rhythm: rhythmLabel(c.citedTimestamps, windowDays),
      systems: [...facts.skills, ...facts.connectors],
      activeHours: facts.activeSecs === null ? null : Math.round(facts.activeSecs / 360) / 10,
      tierNote: tierNoteFor(facts.tiers),
    };
    await upsertOpenSuggestion({
      signalKey,
      title: c.title,
      description: c.story,
      department: department ?? undefined,
      canvas,
      matchingRule: {
        skills: trimCommoditySignals(facts.skills, ruleTrimSet),
        connectors: trimCommoditySignals(facts.connectors, ruleTrimSet),
        taskTypes: [],
        departments: depts,
        keywords: c.keywords,
      },
      evidence: { distinctUsers: c.citedUsers.length, sessionCount: c.citedSessions.length, departments: depts },
      surface,
      citedSessions: c.citedSessions,
      nowS,
    });
    generated++;
  };

  const corpora = await gatherDeptCorpora(nowS, windowDays);

  // Work seen across departments first (listed below the
  // department boxes), so the department passes do not claim it for one of
  // them. Every department's sample contributes, including ones too small on
  // their own.
  // ACROSS_READS reads, each over its own slice of every department's sample:
  // one read proposes only about three, and a bigger single read
  // does not raise that (360 prompts in one read gave
  // 2; four reads gave 5). Each read is told what earlier reads stored, so they
  // add rather than repeat.
  for (let r = 0; r < ACROSS_READS; r++) {
    const across = sampleAcrossDepartments(corpora.map(cp => ({ ...cp, excerpts: cp.excerpts.filter((_e, i) => i % ACROSS_READS === r) })));
    if (new Set(across.excerpts.map(e => e.department)).size < 2 || new Set(across.excerpts.map(e => e.userId)).size < minUsers) continue;
    for (const c of await synthesiseDeptProcesses(across, denylist, acrossBar, f => failures.push(f))) await store(c, null, 'cowork');
  }

  // Department passes over Cowork and Claude Code prompts separately,
  // each department read once per READ_PROMPTS usable prompts, up to MAX_READS, each
  // read over its own slice of a sample that size. Each read is told every
  // title already proposed for the department, including what earlier reads in
  // this run stored, so reads add rather than repeat.
  const deptPasses: Array<{ surface: MinedSurface; corpora: DeptCorpus[] }> = [
    { surface: 'cowork', corpora: await gatherDeptCorpora(nowS, windowDays, undefined, { surface: 'cowork', scaled: true }) },
    { surface: 'code', corpora: await gatherDeptCorpora(nowS, windowDays, undefined, { surface: 'code', scaled: true }) },
  ];
  for (const { corpora: list } of deptPasses) for (const cp of list) if ((cp.reads ?? 1) >= 3) uncapped.add(cp.department);
  const counted = new Set<string>();
  for (const { surface, corpora: list } of deptPasses) {
    for (const corpus of list) {
      const reads = Math.max(1, corpus.reads ?? 1);
      for (let r = 0; r < reads; r++) {
        const slice: DeptCorpus = reads === 1 ? corpus : {
          ...corpus,
          excerpts: corpus.excerpts.filter((_e, i) => i % reads === r).map((e, index) => ({ ...e, index })),
        };
        // Pre-LLM screen: a sample with fewer than two people cannot produce a
        // suggestion, so no call is spent on it.
        if (new Set(slice.excerpts.map(e => e.userId)).size < minUsers) continue;
        if (!counted.has(corpus.department)) { counted.add(corpus.department); departments++; }
        for (const c of await synthesiseDeptProcesses(slice, denylist, deptBar, f => failures.push(f))) await store(c, corpus.department, surface);
      }
    }
  }

  // Marked done first, so a failure is reported without the scheduler
  // re-running the whole job every cycle; then the failure is thrown so it
  // shows in System health instead of passing as "no processes found".
  await setConfigValue('processMiningLastRun', String(nowS));
  if (failures.length) throw new Error(`Process mining failed for ${failures.length} department(s): ${failures.join('; ')}`);
  return { generated, departments };
}
