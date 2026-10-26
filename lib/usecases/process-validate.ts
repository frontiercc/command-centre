// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure, client-safe validation module for department process candidates.
 *
 * Keeps process suggestions process-shaped: every field is grounded in cited
 * excerpts (never invented), digit-free (the model never renders a number —
 * measured figures are injected elsewhere), tool-shaped titles are denylisted,
 * and a candidate must clear a recurrence + materiality bar before it survives.
 *
 * Imports NOTHING beyond `node:crypto` and `@/lib/pii/detect` — this module is
 * consumed by server jobs and (types only) client components, so it must stay
 * free of DB/config/Anthropic dependencies.
 */
import { createHash } from 'node:crypto';
import { redactPii } from '@/lib/pii/detect';

export interface DeptExcerpt {
  index: number;
  text: string; // ALREADY redacted by the corpus layer
  userId: string;
  sessionId: string;
  occurredAt: number;
  /** Set on the cross-department corpus only: the person's department. */
  department?: string;
}

export interface RawProcessCandidate {
  title?: unknown;
  story?: unknown;
  valueHypothesis?: unknown;
  keywords?: unknown;
  excerptIndices?: unknown;
}

export interface ValidProcessCandidate {
  title: string;
  story: string;
  valueHypothesis: string;
  keywords: string[];
  citedUsers: string[];
  citedSessions: string[];
  citedDays: number;
  citedTimestamps: number[];
  /** Departments of the cited excerpts (cross-department corpus only; [] otherwise). */
  citedDepartments: string[];
}

/**
 * What a suggestion must show. A department
 * suggestion needs at least minUsers people, with no one-person route: a
 * one-person job is a habit or a key-person risk, not a department process, and
 * can still be added by hand. A cross-department suggestion also needs
 * minDepartments departments among its cited excerpts.
 */
export interface QualBar {
  minUsers: number;
  minDepartments?: number;
}

export const DEFAULT_PROCESS_DENYLIST: string[] = [
  'reporting', 'drafting', 'spreadsheet analysis', 'data analysis', 'document creation',
  'research', 'summarisation', 'summarization', 'transcription', 'email drafting', 'general assistance',
];

/** Commodity skills trimmed from a mined matching rule regardless of the
 *  admin's `useCasesSuggestExcludedSignals` list (design
 *  decision: keep skills/connectors on the rule but trim the obvious commodity
 *  ones). The FULL untrimmed list still lands on `canvas.systems` — this
 *  constant only ever touches the stored `matchingRule`. */
export const DEFAULT_RULE_SIGNAL_TRIM: string[] = [
  'anthropic-skills:docx', 'anthropic-skills:pptx', 'anthropic-skills:xlsx', 'anthropic-skills:pdf',
];

/** The substring after a value's last ':' (or the whole value with no ':'). */
function suffixAfterColon(value: string): string {
  const i = value.lastIndexOf(':');
  return i === -1 ? value : value.slice(i + 1);
}

/**
 * Suffix-aware trim set (pure, DB-free, so the mining job can build it from
 * its own config read): each entry contributes both its full lowercased
 * value AND the substring after its last ':'.
 */
export function buildSignalTrimSet(values: string[]): Set<string> {
  const set = new Set<string>();
  for (const v of values) {
    const lower = v.toLowerCase();
    set.add(lower);
    set.add(suffixAfterColon(lower));
  }
  return set;
}

/** Drops any value matching `trimSet` by full value or by its ':'-suffix
 *  (same semantics as buildSignalTrimSet's membership check). */
export function trimCommoditySignals(values: string[], trimSet: Set<string>): string[] {
  return values.filter(v => {
    const lower = v.toLowerCase();
    return !trimSet.has(lower) && !trimSet.has(suffixAfterColon(lower));
  });
}

const DAY_SECS = 86400;

export function validateProcessCandidates(
  parsed: unknown,
  excerpts: DeptExcerpt[],
  denylist: string[],
  bar: QualBar,
  /** Told why each proposed process was left out, so a run can say why nothing was suggested. */
  onDrop?: (title: string, reason: string) => void,
): ValidProcessCandidate[] {
  if (!Array.isArray(parsed)) return [];
  const byIndex = new Map(excerpts.map(e => [e.index, e]));
  const deny = new Set(denylist.map(d => d.trim().toLowerCase()));
  const out: ValidProcessCandidate[] = [];

  for (const raw of parsed) {
    if (typeof raw !== 'object' || raw === null) continue;
    const o = raw as Record<string, unknown>;

    // Field presence
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    const story = typeof o.story === 'string' ? o.story.trim() : '';
    const valueHypothesis = typeof o.valueHypothesis === 'string' ? o.valueHypothesis.trim() : '';
    const drop = (reason: string) => onDrop?.(title || '(untitled)', reason);
    if (!title || !story || !valueHypothesis) { drop('a field was empty'); continue; }

    // Digit check — the model never renders a number
    if (/\d/.test(title) || /\d/.test(story) || /\d/.test(valueHypothesis)) { drop('contains a number'); continue; }

    // Denylist — tool-shaped titles, case-insensitive
    if (deny.has(title.toLowerCase())) { drop('title is a tool or activity'); continue; }

    // Citations exist & complete — an invented citation poisons the whole candidate
    const idx = Array.isArray(o.excerptIndices)
      ? o.excerptIndices.filter((n): n is number => typeof n === 'number')
      : [];
    const cited = idx.map(i => byIndex.get(i)).filter((e): e is DeptExcerpt => !!e);
    if (cited.length === 0 || cited.length !== idx.length) { drop('cited an excerpt that does not exist'); continue; }

    // Recurrence — at least 2 distinct UTC days
    const days = new Set(cited.map(e => Math.floor(e.occurredAt / DAY_SECS))).size;
    if (days < 2) { drop('seen on one day only'); continue; }

    // Materiality — enough distinct people OR enough distinct sessions
    const users = [...new Set(cited.map(e => e.userId))];
    const sessions = [...new Set(cited.map(e => e.sessionId))];
    if (users.length < bar.minUsers) {
      drop(`too few people cited (${users.length} of ${bar.minUsers})`);
      continue;
    }
    const departments = [...new Set(cited.map(e => e.department).filter((d): d is string => !!d))].sort();
    if (bar.minDepartments && departments.length < bar.minDepartments) {
      drop(`seen in too few departments (${departments.length} of ${bar.minDepartments})`);
      continue;
    }

    // Keywords are clues for the session judge, not the matching rule:
    // one that does not appear in the cited excerpts is dropped,
    // but a process with none left is still kept.
    const kwRaw = Array.isArray(o.keywords) ? o.keywords.filter((k): k is string => typeof k === 'string') : [];
    const keywords = kwRaw
      .map(k => k.trim())
      .filter(k => k.length >= 3 && cited.some(e => e.text.toLowerCase().includes(k.toLowerCase())));

    out.push({
      title: redactPii(title),
      story: redactPii(story),
      valueHypothesis: redactPii(valueHypothesis),
      keywords,
      citedUsers: users,
      citedSessions: sessions,
      citedDays: days,
      citedTimestamps: cited.map(e => e.occurredAt),
      citedDepartments: departments,
    });
  }

  return out;
}

/**
 * Kinds of work never suggested, checked in code on the title.
 * The mining prompt already forbids them, but measured
 * (nine runs per surface) the instruction did not hold:
 * certification exam practice came up in every run that found it, and so did
 * jobs about running Claude itself ("long-running agent session monitoring",
 * "subagent delegation report review"). Phrases, not single loose words, so
 * real work survives ("insurance agent commissions", "model availability and
 * cost checks", "promotional video localisation").
 * Slide and deck work is dropped from DEPARTMENT suggestions only: the
 * cross-department pass accepts client proposal decks as shared work done for
 * the same purpose, which was kept (option 1).
 */
const PERSONAL_STUDY = /\b(certifications?|exams?|practice (tests?|questions?)|study (plans?|notes?)|revision notes?|career (plans?|planning|development)|personal development|promotion (cases?|justifications?|write-?ups?))\b/i;
const RUNNING_CLAUDE = /\b(sub-?agents?|agentic|claude)\b|\bagents?\s+(sessions?|conversations?|runs?|progress|delegation|dispatch|hand-?backs?|monitoring)\b|\b(background|autonomous|long-running|headless|unattended)\s+(agents?|builds?|sessions?|runs?)\b|\bheadless\b.*\b(runs?|dispatch)\b|\bsession monitoring\b|\bturn-by-turn\b|\b(conversation|session) turns?\b/i;
const SLIDE_WORK = /\b(slides?|slide ?decks?|decks?|presentations?|powerpoint)\b/i;

export type ExcludedKind = 'personal study' | 'about running Claude' | 'slide work';

/** Why a title is a kind of work never suggested, or null. `departmentScope` drops slide work too. */
export function excludedKind(title: string, departmentScope: boolean): ExcludedKind | null {
  if (PERSONAL_STUDY.test(title)) return 'personal study';
  if (RUNNING_CLAUDE.test(title)) return 'about running Claude';
  if (departmentScope && SLIDE_WORK.test(title)) return 'slide work';
  return null;
}

/**
 * True when at least three-quarters of a new suggestion's sessions were
 * behind one a person dismissed or added: it is the same work
 * reworded and is not suggested again. Measured read-only
 *: run 1's suggestions treated as dismissed, run 2's twelve
 * checked. Same-job repeats overlapped 80-100% (one at 67% was about running
 * Claude, which excludedKind drops anyway); the two different jobs that
 * shared sessions (CI failure diagnosis inside infrastructure deployments,
 * architecture diagrams inside an Azure specification) overlapped 67%. Half
 * would have blocked those two; three-quarters blocks every real repeat.
 */
export const RESOLVED_OVERLAP = 0.75;
export function overlapsResolved(sessions: string[], resolved: string[][]): boolean {
  const mine = new Set(sessions);
  if (mine.size === 0) return false;
  return resolved.some(r => {
    const theirs = new Set(r);
    let shared = 0;
    for (const s of mine) if (theirs.has(s)) shared++;
    return shared / mine.size >= RESOLVED_OVERLAP;
  });
}

/** Monday-UTC week bucket. Epoch day 0 (1970-01-01) was a Thursday, so shifting
 * back 4 days before flooring by 7 days aligns week boundaries to Monday. */
function isoWeekBucket(epochSecs: number): number {
  const dayIndex = Math.floor(epochSecs / DAY_SECS);
  return Math.floor((dayIndex - 4) / 7);
}

export function rhythmLabel(
  timestamps: number[],
  windowDays: number,
): { label: 'monthly' | 'weekly' | 'recurring'; display: string } {
  const distinctDays = new Set(timestamps.map(t => Math.floor(t / DAY_SECS))).size;

  const months = new Set(timestamps.map(t => {
    const d = new Date(t * 1000);
    return `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
  }));
  const daysOfMonth = timestamps.map(t => new Date(t * 1000).getUTCDate());

  if (months.size >= 2) {
    const total = timestamps.length;
    const monthEndHits = daysOfMonth.filter(d => d >= 24 || d <= 3).length;
    if (total > 0 && monthEndHits / total >= 0.7) {
      return { label: 'monthly', display: 'Monthly, month-end spike' };
    }
    // A tight <=7-day-of-month band across >=2 months (any band, not just month-end)
    const sorted = [...daysOfMonth].sort((a, b) => a - b);
    let bestCount = 0;
    for (let i = 0; i < sorted.length; i++) {
      let count = 0;
      for (let j = 0; j < sorted.length; j++) {
        if (sorted[j] >= sorted[i] && sorted[j] <= sorted[i] + 6) count++;
      }
      if (count > bestCount) bestCount = count;
    }
    if (total > 0 && bestCount / total >= 0.7) {
      return { label: 'monthly', display: 'Monthly' };
    }
  }

  const weeks = new Set(timestamps.map(isoWeekBucket)).size;
  if (weeks >= 3) {
    return { label: 'weekly', display: 'Weekly' };
  }

  const weeksInWindow = Math.ceil(windowDays / 7);
  return { label: 'recurring', display: `${distinctDays} occasions over ${weeksInWindow} weeks` };
}

export function computeProcessKey(department: string, title: string): string {
  const norm = `process|${department.toLowerCase()}|${title.trim().toLowerCase()}`;
  return createHash('sha256').update(norm).digest('hex').slice(0, 32);
}

export function tierNoteFor(tiers: number[]): string | null {
  if (tiers.length === 0) return null;
  const counts = new Map<number, number>();
  for (const t of tiers) counts.set(t, (counts.get(t) ?? 0) + 1);
  let modeTier = tiers[0];
  let modeCount = 0;
  for (const [tier, count] of counts) {
    if (count > modeCount) {
      modeCount = count;
      modeTier = tier;
    }
  }
  return `Mostly tier ${modeTier}`;
}
