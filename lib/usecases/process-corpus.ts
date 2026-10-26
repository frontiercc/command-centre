// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-department scrubbed prompt-corpus gatherer (Department Process
 * Transformation). Feeds the mining job's LLM pass with grounded,
 * PII-redacted excerpts per department, capped so no single prolific user
 * dominates a department's evidence and no single department dominates a
 * mining run's token budget.
 *
 * Department resolution is the dual rule used elsewhere in this codebase:
 * `users.department`, falling back to the linked `admin_users.department`
 * (via `admin_users.linked_cowork_user_id`) when the users-table value is
 * NULL/blank. A row with neither is excluded — no department, no corpus.
 *
 * Sampling spreads each department's sample across the whole window:
 * the window is cut into weekly buckets and each bucket may fill
 * only its share of MAX_EXCERPTS_PER_DEPT, days taking turns within the bucket, with
 * MAX_EXCERPTS_PER_USER per person and MAX_IDENTICAL_PER_DEPT copies of the
 * same cleaned text (a scheduled task repeats word for word). Quiet weeks leave
 * room that a second pass fills from the rest. Before this, the newest rows won
 * outright: a department with about forty active people
 * got all sixty excerpts from one afternoon, and a process must
 * show on two separate days to count, so it never had a suggestion. Each
 * department's kept rows are then re-sorted OLDEST-first and assigned index
 * 0..n-1 (excerptIndices cited by the mining model must be stable/ordered).
 * Text is the person's own words (cleanPromptText); a prompt with none is
 * skipped.
 *
 * `gatherSessionFacts` is a second, independent reader over the same
 * session-scoped tables (skills/connectors/active time/tiers) used to enrich
 * a mined candidate with measured facts after the LLM pass. Skills and
 * connectors are returned SPLIT (not merged into one "systems" list) because
 * the matching rule needs connectors on their own.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { cleanOutputName, cleanPromptText, type SessionClues } from '@/lib/usecases/prompt-text';
import { chunk } from '@/lib/usecases/impact-rollup';
import { isBuiltInTool } from '@/lib/finance/spend-review-builtins';
import type { DeptExcerpt } from '@/lib/usecases/process-validate';

export interface DeptCorpus {
  department: string;
  excerpts: DeptExcerpt[];
  /** Per session: files uploaded, files made and connector actions, as clues to what the work takes in and produces. */
  clues?: Record<string, SessionClues>;
  /** How many reads this sample is for: 1, or more for a big department. */
  reads?: number;
}

/** Most files of each kind listed per session, and most connector actions: enough to show the work's inputs and outputs. */
export const MAX_FILES_PER_SESSION = 3;
export const MAX_ACTIONS_PER_SESSION = 6;

export interface SessionFacts {
  skills: string[];
  connectors: string[];
  activeSecs: number | null;
  tiers: number[];
}

/** 120, not 60: a forty-person department got the same 60 as a three-person one, too few to show a process recurring. About 18,000 input tokens a department. */
export const MAX_EXCERPTS_PER_DEPT = 120;
export const MAX_EXCERPTS_PER_USER = 10;
/** Copies of the same cleaned prompt kept per department, so a repeated scheduled task cannot fill the sample. */
export const MAX_IDENTICAL_PER_DEPT = 3;
export const EXCERPT_CHARS = 600;
const WEEK_SECS = 7 * 86400;

/**
 * Reads a department gets: one per READ_PROMPTS usable prompts in
 * the window (its own words, after the identical-prompt cap), from 1 to
 * MAX_READS. Each read is a separate sample of MAX_EXCERPTS_PER_DEPT prompts,
 * so the reads together cover every usable prompt up to MAX_READS samples.
 * Counted on prompts, not sessions: one Sales department has
 * 510 Claude Code sessions but 66 usable prompts, and six reads of eleven
 * prompts each would each see too few people to pass the bar.
 * Measured read-only on one department (about 2,000
 * Cowork and 4,600 Claude Code prompts, three runs each): one read kept 0-1
 * jobs a run, six reads kept 5-6 (Cowork) and 10-11 (Claude Code), most of
 * them found again in other runs; one read of 360 prompts kept 1-2. Most
 * proposals fail the two-people / two-days bar, and separate reads over
 * different people find more that pass.
 */
export const READ_PROMPTS = MAX_EXCERPTS_PER_DEPT;
export const MAX_READS = 6;
export const readsForPrompts = (prompts: number): number =>
  Math.min(MAX_READS, Math.max(1, Math.ceil(prompts / READ_PROMPTS)));

/** Prompts mined per surface: Cowork's user messages, and Claude Code's. */
export type MinedSurface = 'cowork' | 'code';
const MESSAGE_TYPE: Record<MinedSurface, string> = { cowork: 'cowork_user_message', code: 'code_user_message' };

const IN_LIST_CHUNK = 500;

interface RawFacade {
  execute: (q: unknown) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}

/** Raw-SQL facade over the Drizzle client's execute(). */
async function rawAll<T>(client: unknown, query: unknown): Promise<T[]> {
  const c = client as RawFacade;
  const res = await c.execute(query);
  return res.rows as T[];
}

export interface DeptRow {
  dept: string;
  user_id: string;
  session_id: string;
  content_full: string;
  occurred_at: number | string; // Postgres returns bigint as string from raw SQL
}

/**
 * Gathers a scrubbed prompt corpus per department over the trailing
 * `windowDays` (from `nowS`).
 */
export async function gatherDeptCorpora(
  nowS: number, windowDays: number, maxIdentical = MAX_IDENTICAL_PER_DEPT,
  /** Which prompts, and whether a big department gets a bigger sample (one per read). */
  opts: { surface?: MinedSurface; scaled?: boolean } = {},
): Promise<DeptCorpus[]> {
  const surface = opts.surface ?? 'cowork';
  const client = await getTypedClient();
  const since = nowS - windowDays * 86400;

  const rows = await rawAll<DeptRow>(client, sql`
    SELECT COALESCE(NULLIF(TRIM(u.department), ''), NULLIF(TRIM(au.department), '')) AS dept,
           cm.user_id AS user_id, cm.session_id AS session_id,
           cm.content_full AS content_full, cm.occurred_at AS occurred_at
      FROM cowork_messages cm
      JOIN users u ON u.id = cm.user_id
      LEFT JOIN admin_users au ON au.linked_cowork_user_id = u.id
     WHERE cm.surface = ${surface} AND cm.message_type = ${MESSAGE_TYPE[surface]}
       AND cm.occurred_at >= ${since} AND cm.session_id IS NOT NULL
       AND cm.content_full IS NOT NULL AND TRIM(cm.content_full) != ''
       AND COALESCE(NULLIF(TRIM(u.department), ''), NULLIF(TRIM(au.department), '')) IS NOT NULL
     ORDER BY cm.occurred_at DESC`);

  const corpora = sampleDeptCorpora(rows, nowS, windowDays, maxIdentical, opts.scaled ? readsForPrompts : () => 1);
  const clues = await loadSessionClues([...new Set(corpora.flatMap(c => c.excerpts.map(e => e.sessionId)))]);
  for (const c of corpora) {
    const mine: Record<string, SessionClues> = {};
    for (const e of c.excerpts) { const k = clues.get(e.sessionId); if (k) mine[e.sessionId] = k; }
    if (Object.keys(mine).length > 0) c.clues = mine;
  }
  return corpora;
}

/** The cross-department sample's size: the same budget as one department's. */
export const MAX_EXCERPTS_ACROSS = 120;
/** The department label on the cross-department corpus. */
export const ACROSS_DEPARTMENTS = 'Across departments';

/**
 * Pure: one sample across departments for the cross-department suggestions
 * (below the department boxes, work done in several departments).
 * Departments take turns for a share, so a large department cannot fill it,
 * and each share is taken evenly through that department's own sample; each
 * excerpt carries its department. Re-sorted oldest first and indexed
 * 0..n-1, with each session's clues kept.
 */
export function sampleAcrossDepartments(corpora: DeptCorpus[], max = MAX_EXCERPTS_ACROSS): DeptCorpus {
  // How many each department gives: departments take turns, so a large one
  // cannot fill the sample and a small one gives all it has.
  const share = corpora.map(() => 0);
  let left = max;
  let progress = true;
  while (left > 0 && progress) {
    progress = false;
    corpora.forEach((cp, i) => {
      if (left > 0 && share[i] < cp.excerpts.length) { share[i]++; left--; progress = true; }
    });
  }
  // Which ones: evenly spaced through the department's own sample (oldest
  // first, already spread over the window's weeks and days), so the whole
  // window is represented, not just its oldest prompts (review).
  const picked: Array<DeptExcerpt & { department: string }> = [];
  const clues: Record<string, SessionClues> = {};
  corpora.forEach((cp, i) => {
    const n = cp.excerpts.length;
    for (let k = 0; k < share[i]; k++) {
      const e = cp.excerpts[Math.floor((k * n) / share[i])];
      picked.push({ ...e, department: cp.department });
      if (cp.clues?.[e.sessionId]) clues[e.sessionId] = cp.clues[e.sessionId];
    }
  });
  const excerpts = picked
    .sort((x, y) => x.occurredAt - y.occurredAt)
    .map((e, index) => ({ ...e, index }));
  return { department: ACROSS_DEPARTMENTS, excerpts, ...(Object.keys(clues).length ? { clues } : {}) };
}

/**
 * What each session took in and handed out, from data already captured (no
 * content): file names uploaded (`cowork_sessions.files_uploaded`), file names
 * made (`cowork_messages.output_name`, successful Write / SendUserFile / Artifact;
 * about one Cowork session in ten) and connector
 * actions (`cowork_mcp_invocations` server + action). A name like
 * "timesheet-chase-tracker.html" or an action like "gmail create_draft" says what
 * the work produces. Names are cleaned (paths, links, PII). Shared by mining and
 * the session judge. Sessions with no clue are absent from the map.
 */
export async function loadSessionClues(sessionIds: string[]): Promise<Map<string, SessionClues>> {
  const out = new Map<string, SessionClues>();
  if (sessionIds.length === 0) return out;
  const get = (s: string) => {
    let c = out.get(s);
    if (!c) { c = { made: [], uploaded: [], actions: [] }; out.set(s, c); }
    return c;
  };
  const add = (list: string[], value: string, cap: number) => {
    if (value && list.length < cap && !list.includes(value)) list.push(value);
  };
  const client = await getTypedClient();
  const cm = schema.coworkMessages;
  const cs = schema.coworkSessions;
  const mi = schema.coworkMcpInvocations;
  for (const ids of chunk(sessionIds, IN_LIST_CHUNK)) {
    const made = await client
      .selectDistinct({ s: cm.session_id, name: cm.output_name })
      .from(cm)
      .where(and(inArray(cm.session_id, ids), sql`${cm.output_name} IS NOT NULL`));
    for (const r of made) if (r.s) add(get(r.s).made, cleanOutputName(r.name), MAX_FILES_PER_SESSION);

    const uploads = await client
      .select({ s: cs.id, files: cs.files_uploaded })
      .from(cs)
      .where(and(inArray(cs.id, ids), sql`${cs.files_uploaded} IS NOT NULL`));
    for (const r of uploads) {
      let names: unknown = [];
      try { names = JSON.parse(r.files ?? '[]'); } catch { names = []; }
      if (!Array.isArray(names)) continue;
      for (const n of names) if (typeof n === 'string') add(get(r.s).uploaded, cleanOutputName(n), MAX_FILES_PER_SESSION);
    }

    const actions = await client
      .selectDistinct({ s: mi.session_id, server: mi.mcp_server, tool: mi.mcp_tool })
      .from(mi)
      .where(and(inArray(mi.session_id, ids), eq(mi.success, 1)));
    for (const r of actions) {
      // Claude's own tools (workspace bash, cowork present_files, remote-devices...)
      // say nothing about the work: on a production A/B test long lists of
      // them pulled meeting prep into a document-discovery use case.
      if (!r.s || !r.server || isBuiltInTool('connector', r.server)) continue;
      add(get(r.s).actions, cleanOutputName(r.tool ? `${r.server} ${r.tool}` : r.server), MAX_ACTIONS_PER_SESSION);
    }
  }
  for (const [k, c] of out) if (!c.made.length && !c.uploaded.length && !c.actions.length) out.delete(k);
  return out;
}

/** Pure: newest-first rows → per-department samples spread across the window. Exported for tests. */
export function sampleDeptCorpora(
  rows: DeptRow[], nowS: number, windowDays: number, maxIdentical = MAX_IDENTICAL_PER_DEPT,
  /** Reads a department gets from its usable prompt count; each read is one more MAX_EXCERPTS_PER_DEPT (1 = today's single read). */
  readsFor: (sessions: number) => number = () => 1,
): DeptCorpus[] {
  const buckets = Math.max(1, Math.ceil(windowDays / 7));
  const bucketOf = (at: number) => Math.min(buckets - 1, Math.max(0, Math.floor((nowS - at) / WEEK_SECS)));

  interface Cand { row: DeptRow; text: string; at: number; bucket: number }
  const byDept = new Map<string, Cand[]>();
  for (const row of rows) {
    const text = cleanPromptText(row.content_full);
    if (!text) continue;
    const at = Number(row.occurred_at);
    const list = byDept.get(row.dept) ?? [];
    list.push({ row, text, at, bucket: bucketOf(at) });
    byDept.set(row.dept, list);
  }

  const corpora: DeptCorpus[] = [];
  for (const [department, cands] of byDept) {
    cands.sort((a, b) => b.at - a.at); // newest first
    // Usable prompts: the person's own words, at most maxIdentical copies of the same text.
    const copies = new Map<string, number>();
    let usable = 0;
    for (const c of cands) {
      const k = c.text.toLowerCase();
      const n = (copies.get(k) ?? 0) + 1;
      copies.set(k, n);
      if (n <= maxIdentical) usable++;
    }
    const reads = Math.max(1, readsFor(usable));
    const maxDept = MAX_EXCERPTS_PER_DEPT * reads;
    const maxUser = MAX_EXCERPTS_PER_USER * reads;
    const perBucket = Math.ceil(maxDept / buckets);
    const kept = new Set<Cand>();
    const perUser = new Map<string, number>();
    const perText = new Map<string, number>();
    const perBucketCount = new Map<number, number>();
    const tryKeep = (c: Cand, respectBucket: boolean): void => {
      if (kept.size >= maxDept || kept.has(c)) return;
      if ((perUser.get(c.row.user_id) ?? 0) >= maxUser) return;
      const key = c.text.toLowerCase();
      if ((perText.get(key) ?? 0) >= maxIdentical) return;
      if (respectBucket && (perBucketCount.get(c.bucket) ?? 0) >= perBucket) return;
      kept.add(c);
      perUser.set(c.row.user_id, (perUser.get(c.row.user_id) ?? 0) + 1);
      perText.set(key, (perText.get(key) ?? 0) + 1);
      perBucketCount.set(c.bucket, (perBucketCount.get(c.bucket) ?? 0) + 1);
    };
    // Days take turns: each day's newest prompt, then each day's second, and so
    // on, so a week's share is spread over its days rather than taken from its
    // busiest last afternoon (the first production proof run: 60 excerpts on 4 days).
    const dayRank = new Map<Cand, number>();
    const perDay = new Map<number, number>();
    for (const c of cands) {
      const d = Math.floor(c.at / 86400);
      const r = perDay.get(d) ?? 0;
      dayRank.set(c, r);
      perDay.set(d, r + 1);
    }
    const order = [...cands].sort((a, b) => dayRank.get(a)! - dayRank.get(b)! || b.at - a.at);
    for (const c of order) tryKeep(c, true);   // each week up to its share
    for (const c of order) tryKeep(c, false);  // quiet weeks' room goes to the rest

    const oldestFirst = [...kept].sort((a, b) => a.at - b.at);
    const excerpts: DeptExcerpt[] = oldestFirst.map((c, index) => ({
      index,
      text: c.text.slice(0, EXCERPT_CHARS),
      userId: c.row.user_id,
      sessionId: c.row.session_id,
      occurredAt: c.at,
    }));
    corpora.push({ department, excerpts, reads });
  }

  corpora.sort((a, b) => a.department.localeCompare(b.department));
  return corpora;
}

/**
 * Session-scoped facts (skills/connectors used, summed active time, tiers
 * seen) over an arbitrary set of session ids — used to enrich a mined
 * candidate with measured evidence. IN-lists are batched at 500 (codebase
 * convention, see lib/usecases/impact.ts).
 */
export async function gatherSessionFacts(sessionIds: string[]): Promise<SessionFacts> {
  if (sessionIds.length === 0) {
    return { skills: [], connectors: [], activeSecs: null, tiers: [] };
  }

  const client = await getTypedClient();
  const skillSet = new Set<string>();
  const connectorSet = new Set<string>();
  let activeSum = 0;
  let anyActiveNonNull = false;
  const tiers: number[] = [];

  for (const ids of chunk(sessionIds, IN_LIST_CHUNK)) {
    const si = schema.coworkSkillInvocations;
    const skillRows = await client
      .select({ v: si.skill_name })
      .from(si)
      .where(inArray(si.session_id, ids));
    for (const r of skillRows) if (r.v) skillSet.add(r.v);

    const mi = schema.coworkMcpInvocations;
    const mcpRows = await client
      .select({ v: mi.mcp_server })
      .from(mi)
      .where(inArray(mi.session_id, ids));
    for (const r of mcpRows) if (r.v) connectorSet.add(r.v);

    const cs = schema.coworkSessionStats;
    const statRows = await client
      .select({
        n: sql<number>`COUNT(${cs.active_secs})`,
        s: sql<number>`COALESCE(SUM(${cs.active_secs}), 0)`,
      })
      .from(cs)
      .where(inArray(cs.session_id, ids));
    const n = Number(statRows[0]?.n ?? 0);
    if (n > 0) {
      anyActiveNonNull = true;
      activeSum += Number(statRows[0]?.s ?? 0);
    }

    const pc = schema.pulseClassifications;
    const cm = schema.coworkMessages;
    const tierRows = await client
      .select({ tier: pc.tier })
      .from(pc)
      .innerJoin(cm, eq(cm.id, pc.cowork_message_id))
      .where(and(inArray(cm.session_id, ids), eq(pc.classifier_status, 'classified')));
    for (const r of tierRows) tiers.push(Number(r.tier));
  }

  return {
    skills: [...skillSet].sort(),
    connectors: [...connectorSet].sort(),
    activeSecs: anyActiveNonNull ? activeSum : null,
    tiers,
  };
}
