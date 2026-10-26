// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Scrubbed prompt corpus for ONE use case ("Turn this into a skill").
 * Reads the sessions the tracker already matched to the use
 * case (use_case_week_matches) over the trailing 13 completed Monday-UTC weeks
 * plus the current week, then their readable Cowork user prompts. redactPii
 * runs HERE, before anything else sees the text — the same discipline as
 * gatherDeptCorpora. Every number in `stats` is measured over ALL readable
 * matched prompts; none comes from a model. Sampling (for the prompt only)
 * walks sessions newest-first; a session that does not fit under the caps is
 * truncated to its opener plus its earliest follow-ups, and skipped only when
 * not even the opener fits, because a follow-up without its opener is
 * meaningless.
 */
import { and, eq, inArray, ne } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { cleanPromptText } from '@/lib/usecases/prompt-text';
import { weekStart, weekStarts } from '@/lib/pulse/period';
import { chunk } from '@/lib/usecases/impact-rollup';
import { gatherSessionFacts } from '@/lib/usecases/process-corpus';
import type { SkillCorpusStats } from '@/lib/usecases/skill-readiness';

export type { SkillCorpusStats };

export interface SkillExcerpt {
  index: number;
  text: string;          // ALREADY redacted
  personLabel: string;   // 'A', 'B', ... — never an id
  userId: string;
  sessionId: string;
  occurredAt: number;
  isFollowUp: boolean;   // not the earliest user prompt in its session
}

export interface SkillCorpus {
  excerpts: SkillExcerpt[];
  stats: SkillCorpusStats;
  systems: string[];     // skills + connectors seen in the matched sessions (measured)
}

export interface CorpusRow {
  user_id: string;
  session_id: string;
  content_full: string;
  occurred_at: number | string; // Postgres returns bigint as string
}

export const MAX_EXCERPTS_PER_DRAFT = 60;
export const MAX_EXCERPTS_PER_USER = 10;
export const EXCERPT_CHARS = 600;
export const WINDOW_WEEKS = 13;
const IN_LIST_CHUNK = 500;
const WEEK = 7 * 86400;

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function labelFor(i: number): string {
  let s = '';
  let n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

/** Pure: rows (any order) → scrubbed, sampled, oldest-first excerpts + measured stats over every readable row. */
export function buildCorpusFromRows(rows: CorpusRow[], unreadableSessions: number): Omit<SkillCorpus, 'systems'> {
  // The person's own words (cleanPromptText: Cowork's system text, the
  // scheduled-task preamble and other wrappers removed, identity stripped,
  // PII masked), so every count and excerpt below is about what people asked
  // for; a prompt that was only a wrapper or redacted does not count.
  const typed = rows
    .map(r => ({ ...r, occurred_at: Number(r.occurred_at), content_full: cleanPromptText(r.content_full) }))
    .filter(r => r.content_full !== '');

  const bySession = new Map<string, typeof typed>();
  for (const r of typed) bySession.set(r.session_id, [...(bySession.get(r.session_id) ?? []), r]);
  const sessions = [...bySession.entries()]
    .map(([sid, list]) => ({ sid, userId: list[0].user_id, list: [...list].sort((a, b) => a.occurred_at - b.occurred_at) }))
    .sort((a, b) => b.list[0].occurred_at - a.list[0].occurred_at); // newest session first

  // A session that does not fit whole keeps its OPENING prompt and as many of
  // its earliest follow-ups as still fit under both caps:
  // skipping it whole let a person who works in long sessions read as ready
  // while sending the model nothing. A session is skipped only when not even
  // its opener fits, so a follow-up never appears without its opener.
  const perUser = new Map<string, number>();
  let total = 0;
  const kept: typeof sessions = [];
  for (const s of sessions) {
    const u = perUser.get(s.userId) ?? 0;
    const room = Math.min(MAX_EXCERPTS_PER_USER - u, MAX_EXCERPTS_PER_DRAFT - total);
    if (room < 1) continue;
    const take = s.list.slice(0, room); // list is oldest-first, so [0] is the opener
    perUser.set(s.userId, u + take.length);
    total += take.length;
    kept.push({ ...s, list: take });
  }

  const flat = kept
    .flatMap(s => s.list.map((r, i) => ({ r, isFollowUp: i > 0 })))
    .sort((a, b) => a.r.occurred_at - b.r.occurred_at);
  const labels = new Map<string, string>();
  const excerpts: SkillExcerpt[] = flat.map((x, index) => {
    if (!labels.has(x.r.user_id)) labels.set(x.r.user_id, labelFor(labels.size));
    return {
      index,
      text: x.r.content_full.slice(0, EXCERPT_CHARS), // already cleaned and PII-masked above
      personLabel: labels.get(x.r.user_id)!,
      userId: x.r.user_id,
      sessionId: x.r.session_id,
      occurredAt: x.r.occurred_at,
      isFollowUp: x.isFollowUp,
    };
  });

  // Stats describe the FULL readable evidence, not the capped sample (branch
  // review #1): readiness and the on-screen evidence line must reflect every
  // prompt the tracker matched, or a busy single owner could never reach solo
  // mode and a 500-prompt use case would read "60 prompts". Only the model sees
  // the sample; `promptsShown` says how much of it was sent.
  const allFollowUps = sessions.reduce((n, s) => n + s.list.length - 1, 0);
  const distinct = distinctPromptCount(typed.map(r => r.content_full));
  const days = new Set(typed.map(r => Math.floor(r.occurred_at / 86400)));
  // reduce, not Math.min(...spread): a large evidence set must not blow the call stack.
  const firstAt = typed.length ? typed.reduce((m, r) => Math.min(m, r.occurred_at), Infinity) : null;
  const lastAt = typed.length ? typed.reduce((m, r) => Math.max(m, r.occurred_at), -Infinity) : null;
  const weeksSpanned = firstAt === null || lastAt === null ? 0 : Math.floor((weekStart(lastAt) - weekStart(firstAt)) / WEEK) + 1;

  return {
    excerpts,
    stats: {
      prompts: typed.length,
      distinctPrompts: distinct,
      people: new Set(typed.map(r => r.user_id)).size,
      sessions: sessions.length,
      days: days.size,
      followUps: allFollowUps,
      weeksSpanned,
      unreadableSessions,
      firstAt,
      lastAt,
      promptsShown: excerpts.length,
    },
  };
}

/**
 * Distinct prompts after normalisation (case, punctuation, whitespace) of the
 * first EXCERPT_CHARS characters — the same slice the model would see. Used
 * for the full-evidence stat here and, over the sampled excerpt texts, for the
 * validator's thin-coverage ratio.
 */
export function distinctPromptCount(texts: string[]): number {
  return new Set(texts.map(t => normalise(t.slice(0, EXCERPT_CHARS)))).size;
}

export async function gatherSkillCorpus(useCaseId: string, nowS: number): Promise<SkillCorpus> {
  const client = await getTypedClient();
  const wm = schema.useCaseWeekMatches;
  const cm = schema.coworkMessages;

  const windowWeeks = [...weekStarts(nowS - WEEK, WINDOW_WEEKS), weekStart(nowS)];

  const matchRows = await client
    .select({ session_id: wm.session_id })
    .from(wm)
    .where(and(eq(wm.use_case_id, useCaseId), inArray(wm.week_start, windowWeeks), ne(wm.session_id, '')));
  const sessionIds = [...new Set(matchRows.map(r => r.session_id))];
  if (sessionIds.length === 0) return { ...buildCorpusFromRows([], 0), systems: [] };

  const rows: CorpusRow[] = [];
  const readable = new Set<string>();
  const stripped = new Set<string>();
  for (const ids of chunk(sessionIds, IN_LIST_CHUNK)) {
    const r = await client
      .select({ user_id: cm.user_id, session_id: cm.session_id, content_full: cm.content_full, occurred_at: cm.occurred_at })
      .from(cm)
      .where(and(inArray(cm.session_id, ids), eq(cm.surface, 'cowork'), eq(cm.message_type, 'cowork_user_message')));
    for (const row of r) {
      if (!row.user_id) continue;
      if (row.content_full && row.content_full.trim() !== '') {
        rows.push({ user_id: row.user_id, session_id: row.session_id, content_full: row.content_full, occurred_at: row.occurred_at as number | string });
        readable.add(row.session_id);
      } else {
        stripped.add(row.session_id);
      }
    }
  }
  const unreadable = [...stripped].filter(s => !readable.has(s)).length;

  const facts = await gatherSessionFacts(sessionIds);
  const systems = [...new Set([...facts.skills, ...facts.connectors])].sort();
  return { ...buildCorpusFromRows(rows, unreadable), systems };
}
