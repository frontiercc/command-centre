// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Who is doing a use case, judged by the work.
 *
 * For each finished Cowork or Code session (idle 30 minutes) whose person's
 * department has live use cases (confirmed or candidate; a use case with no
 * department applies to everyone), a model reads up to six of the session's
 * prompts, cleaned and spread across the session, plus the tools used, and
 * says which of those use cases the session is an instance of: none, one or
 * several. A session that runs a use case's own codified skill is a match
 * without asking. Answers are written to the same weekly
 * match table the tracker filled before, so lifecycle, hours, governance,
 * skill drafting and the frontier pages read them unchanged.
 *
 * Judged again when the session has new activity, or when the use cases it is
 * judged against change (candidate_key), which is also how a newly confirmed
 * use case gets its 13 weeks of history. At most JUDGE_MAX_SESSIONS_PER_RUN a
 * run, newest first, one call at a time, so a big backfill spreads over hours.
 *
 * Validated read-only before this was built: 893 sessions in
 * four departments, 91 calls, no prose or cut-off replies, about 28 of 30
 * matches right, where tool matching had 66 sessions for a process with 3.
 */
import { createHash } from 'node:crypto';
import { and, inArray, isNotNull, sql } from 'drizzle-orm';
import { createAnthropicClient, LONG_AI_CALL_TIMEOUT_MS } from '@/lib/anthropic/client';
import { extractText } from '@/lib/anthropic/constants';
import { getAllConfig, getConfigValue, setConfigValue } from '@/lib/config';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { queueAiCall } from '@/lib/ingestion/scheduler';
import { weekStart } from '@/lib/pulse/period';
import { chunk, recomputeWeekImpact } from '@/lib/usecases/impact-rollup';
import { cleanPromptText, formatClues, stripIdentity } from '@/lib/usecases/prompt-text';
import { loadSessionClues } from '@/lib/usecases/process-corpus';
import { listUseCases, type UseCase } from '@/lib/usecases/queries';
import { addSessionMatch, refreshWeekFromJunction, removeSessionMatches } from '@/lib/usecases/weeks';
import { signalMatches } from '@/lib/usecases/signal-match';
import { thinkingOff } from '@/lib/anthropic/thinking';

export const JUDGE_IDLE_SECS = 30 * 60;
export const JUDGE_WINDOW_DAYS = 91; // 13 weeks: the governance window, and the history a newly confirmed use case gets
export const JUDGE_MAX_SESSIONS_PER_RUN = 400;
export const JUDGE_BATCH = 10;
export const JUDGE_MAX_TOKENS = 4000;
const PROMPTS_PER_SESSION = 6;
const PROMPT_CHARS = 400;
const REASON_CHARS = 200;
const IN_CHUNK = 500;

// ─── Pure parts ──────────────────────────────────────────────────────────────

/** Up to six prompts spread across the session: the first two, two from the middle, the last two. */
export function spreadPrompts<T>(items: T[]): T[] {
  if (items.length <= PROMPTS_PER_SESSION) return items;
  const m = Math.floor(items.length / 2);
  return [items[0], items[1], items[m - 1], items[m], items[items.length - 2], items[items.length - 1]];
}

export interface JudgeCandidate { id: string; title: string; description: string | null; keywords: string[] }

/** Changes when any use case a session is judged against is added, removed or reworded, so the session is judged again. */
export function candidateKey(cands: JudgeCandidate[]): string {
  const canon = [...cands]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(c => [c.id, c.title, c.description ?? '', [...c.keywords].sort().join('|')]);
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex').slice(0, 32);
}

export const JUDGE_SYSTEM = `You classify work sessions. Each session is one person's conversation with their AI assistant. You are given the recurring pieces of work (use cases) for the person's department, each with an id, a title, a description and some phrases people use for it, and a batch of sessions: prompts sampled from across each session, plus the tools seen and, where known, the files uploaded, the files made and the connector actions, as clues.
For each session list every use case it is genuinely an instance of: none, one, or several (one long session can cover more than one job).
A session counts only if the work itself is that use case: judge by what the work is about, its subject and its output. Match the specific job described, not its general area: the session must produce that use case's kind of output for that purpose. Other work in the same area, a general question about the topic, or preparing for or following up on something different does not count. Being scheduled, automated or run without the user present never makes a session an instance of a use case, and neither does using similar tools or touching a related topic. A scheduled task matches only if its own task (its name and instructions) is that use case. Tools, files and actions are clues, never sufficient alone; a file made is good evidence of what the work produced. When unsure, leave it out.
Return one entry per session: s = the session number, why = at most twelve words on what the session's work was, written first, then p = the use case ids that work is an instance of (empty for none).`;

export const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        // why before p: the reply is written in this order, so the model says what the work was before it decides (production proof run: with p first, a reply read "not a provisioning request" and still matched it).
        properties: { s: { type: 'integer' }, why: { type: 'string' }, p: { type: 'array', items: { type: 'string' } } },
        required: ['s', 'why', 'p'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
} as const;

export interface JudgeSessionInput {
  surface: string;
  prompts: string[];
  tools: string[];
  /** formatClues(): files uploaded, files made, connector actions; '' or absent when none. */
  clues?: string;
}

/** The user message for one batch. Use cases get short ids (U1, U2...) so the reply cannot name anything else. */
export function buildJudgeMessage(department: string | null, cands: JudgeCandidate[], sessions: JudgeSessionInput[]): string {
  const ucs = cands.map((c, i) => {
    const kw = c.keywords.length ? ` Phrases: ${c.keywords.map(k => JSON.stringify(k)).join(', ')}.` : '';
    return `U${i + 1}: ${c.title} :: ${c.description ?? ''}${kw}`;
  }).join('\n');
  const body = sessions.map((s, j) =>
    `Session ${j + 1} (${s.surface}, ${s.prompts.length} prompts):\n`
    + spreadPrompts(s.prompts).map(p => `  prompt: ${JSON.stringify(p.slice(0, PROMPT_CHARS))}`).join('\n')
    + `\n  tools: ${s.tools.length ? s.tools.join(', ') : 'none'}`
    + (s.clues ? `\n  ${s.clues}` : ''),
  ).join('\n\n');
  return `Department: ${department ?? 'none'}\nUse cases:\n${ucs}\n\nSessions:\n${body}`;
}

/** Per session in the batch: the matched use case ids and the reason, or null when the reply left the session out. */
export function parseJudgeReply(text: string, cands: JudgeCandidate[], batchSize: number): Array<{ ids: string[]; why: string } | null> | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  const results = (parsed as { results?: unknown })?.results;
  if (!Array.isArray(results)) return null;
  const byShort = new Map(cands.map((c, i) => [`U${i + 1}`, c.id]));
  const out: Array<{ ids: string[]; why: string } | null> = Array.from({ length: batchSize }, () => null);
  for (const r of results) {
    const o = r as { s?: unknown; p?: unknown; why?: unknown };
    if (typeof o.s !== 'number' || o.s < 1 || o.s > batchSize) continue;
    const ids = Array.isArray(o.p)
      ? [...new Set(o.p.filter((x): x is string => typeof x === 'string').map(x => byShort.get(x.trim())).filter((x): x is string => !!x))]
      : [];
    out[o.s - 1] = { ids, why: typeof o.why === 'string' ? o.why : '' };
  }
  return out;
}

/** True when a telemetry skill name is the codified skill (exact, or its suffix after a marketplace prefix; case-insensitive). */
export function isCodifiedSkill(skillName: string, telemetryName: string): boolean {
  return signalMatches(new Set([skillName]), telemetryName);
}

// ─── The job ─────────────────────────────────────────────────────────────────

interface LiveUseCase { uc: UseCase; cand: JudgeCandidate; skillName: string | null }

interface ReadySession {
  surface: 'cowork' | 'code';
  session_id: string;
  user_id: string;
  dept: string | null;
  first_at: number;
  last_at: number;
  j_last: number | null;
  j_key: string | null;
  j_ids: string | null;
  j_skill: string | null;
  j_model: string | null;
  j_prompts: number | null;
}

export interface JudgeRunResult {
  considered: number;
  judged: number;
  matchedSessions: number;
  failedBatches: number;
  apiError?: string;
}

function parseIds(raw: string | null): string[] {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
}

async function loadLiveUseCases(): Promise<LiveUseCase[]> {
  const ucs = (await listUseCases()).filter(u => u.status !== 'archived');
  if (ucs.length === 0) return [];
  const client = await getTypedClient();
  const d = schema.useCaseSkillDrafts;
  const drafts = await client.select({ id: d.use_case_id, name: d.skill_name }).from(d).where(isNotNull(d.downloaded_at));
  const skillByUc = new Map(drafts.map(r => [r.id, r.name]));
  return ucs.map(uc => ({
    uc,
    cand: { id: uc.id, title: uc.title, description: uc.description ?? null, keywords: uc.keywords ?? [] },
    skillName: skillByUc.get(uc.id) ?? null,
  }));
}

/** The live use cases a session is judged against: its department's, plus any with no department; narrowed by a use case's surfaces when set. */
function candidatesFor(live: LiveUseCase[], dept: string | null, surface: string): LiveUseCase[] {
  return live.filter(l =>
    (l.uc.departments.length === 0 || (dept !== null && l.uc.departments.includes(dept)))
    && (l.uc.surfaces.length === 0 || l.uc.surfaces.includes(surface)));
}

async function loadReadySessions(nowS: number): Promise<ReadySession[]> {
  const client = await getTypedClient();
  const since = nowS - JUDGE_WINDOW_DAYS * 86400;
  const idleBefore = nowS - JUDGE_IDLE_SECS;
  const res = await client.execute(sql`
    WITH s AS (
      SELECT 'cowork' AS surface, session_id, user_id, first_event_at AS first_at, last_event_at AS last_at
        FROM cowork_session_stats
       WHERE user_id IS NOT NULL AND last_event_at IS NOT NULL AND last_event_at >= ${since} AND last_event_at < ${idleBefore}
      UNION ALL
      SELECT 'code', session_id, user_id, first_at, last_at
        FROM code_session_stats
       WHERE user_id IS NOT NULL AND last_at >= ${since} AND last_at < ${idleBefore}
    )
    SELECT s.surface, s.session_id, s.user_id, COALESCE(s.first_at, s.last_at) AS first_at, s.last_at,
           COALESCE(NULLIF(TRIM(u.department), ''), NULLIF(TRIM(au.department), '')) AS dept,
           j.last_event_at AS j_last, j.candidate_key AS j_key, j.use_case_ids AS j_ids, j.skill_matched_ids AS j_skill,
           j.model AS j_model, j.prompt_count AS j_prompts
      FROM s
      LEFT JOIN users u ON u.id = s.user_id
      LEFT JOIN admin_users au ON au.linked_cowork_user_id = s.user_id
      LEFT JOIN use_case_session_judgements j ON j.session_id = s.session_id
     ORDER BY s.last_at DESC`);
  const rows = (res as unknown as { rows: Array<Record<string, unknown>> }).rows;
  return rows.map(r => ({
    surface: r.surface === 'code' ? 'code' : 'cowork',
    session_id: String(r.session_id),
    user_id: String(r.user_id),
    dept: r.dept == null ? null : String(r.dept),
    first_at: Number(r.first_at),
    last_at: Number(r.last_at),
    j_last: r.j_last == null ? null : Number(r.j_last),
    j_key: r.j_key == null ? null : String(r.j_key),
    j_ids: r.j_ids == null ? null : String(r.j_ids),
    j_skill: r.j_skill == null ? null : String(r.j_skill),
    j_model: r.j_model == null ? null : String(r.j_model),
    j_prompts: r.j_prompts == null ? null : Number(r.j_prompts),
  }));
}

async function loadPromptsAndTools(sessionIds: string[]): Promise<{ prompts: Map<string, string[]>; tools: Map<string, string[]> }> {
  const client = await getTypedClient();
  const prompts = new Map<string, string[]>();
  const tools = new Map<string, Set<string>>();
  for (const ids of chunk(sessionIds, IN_CHUNK)) {
    const cm = schema.coworkMessages;
    const rows = await client
      .select({ session_id: cm.session_id, content: cm.content_full, at: cm.occurred_at })
      .from(cm)
      .where(and(
        inArray(cm.session_id, ids),
        inArray(cm.message_type, ['cowork_user_message', 'code_user_message']),
        isNotNull(cm.content_full),
      ))
      .orderBy(cm.occurred_at);
    for (const r of rows) {
      const text = cleanPromptText(r.content);
      if (!text || !r.session_id) continue;
      const list = prompts.get(r.session_id) ?? [];
      list.push(text);
      prompts.set(r.session_id, list);
    }
    const si = schema.coworkSkillInvocations;
    const mi = schema.coworkMcpInvocations;
    const skills = await client.select({ s: si.session_id, v: si.skill_name }).from(si).where(inArray(si.session_id, ids));
    const mcps = await client.select({ s: mi.session_id, v: mi.mcp_server }).from(mi).where(inArray(mi.session_id, ids));
    for (const r of [...skills, ...mcps]) {
      if (!r.s || !r.v) continue;
      const set = tools.get(r.s) ?? new Set<string>();
      set.add(r.v);
      tools.set(r.s, set);
    }
  }
  return { prompts, tools: new Map([...tools].map(([k, v]) => [k, [...v].sort()])) };
}

/**
 * One judging run. Never throws for a model failure: an API error stops the
 * run and is returned as apiError (nothing more is attempted; sessions not yet
 * judged wait for the next run); an unreadable or cut-off batch is counted in
 * failedBatches and retried next run. The caller turns either into a job
 * failure so it shows in System health.
 */
export async function runUseCaseJudgeJob(opts?: { nowS?: number }): Promise<JudgeRunResult> {
  const nowS = opts?.nowS ?? Math.floor(Date.now() / 1000);
  const result: JudgeRunResult = { considered: 0, judged: 0, matchedSessions: 0, failedBatches: 0 };
  if ((await getConfigValue('useCasesEnabled')) !== 'true') return result;
  const cfg = await getAllConfig() as unknown as Record<string, string | undefined>;
  const contentOn = cfg.useCasesSuggestUseContent === 'true';
  const model = (cfg.useCaseJudgeModel ?? '').trim() || 'claude-sonnet-5';
  const apiKey = contentOn ? await getConfigValue('anthropicAiApiKey') : '';

  const live = await loadLiveUseCases();

  // Which sessions need (re)judging, newest first.
  const todo: Array<{ s: ReadySession; cands: LiveUseCase[]; key: string; prev: string[] }> = [];
  for (const s of await loadReadySessions(nowS)) {
    const cands = candidatesFor(live, s.dept, s.surface);
    const key = candidateKey(cands.map(c => c.cand));
    const prev = [...new Set([...parseIds(s.j_ids), ...parseIds(s.j_skill)])];
    if (cands.length === 0 && prev.length === 0) continue; // nothing to judge against, nothing to undo
    const judgedBefore = s.j_last !== null;
    // Recorded without a model answer while content was off, though it has
    // readable prompts: judge it now that content is on.
    const awaitingContent = contentOn && judgedBefore && s.j_model === null && (s.j_prompts ?? 0) > 0 && cands.length > 0;
    if (judgedBefore && s.j_last! >= s.last_at && s.j_key === key && !awaitingContent) continue;
    todo.push({ s, cands, key, prev });
    if (todo.length >= JUDGE_MAX_SESSIONS_PER_RUN) break;
  }
  result.considered = todo.length;
  if (todo.length === 0) return result;

  const { prompts, tools } = await loadPromptsAndTools(todo.map(t => t.s.session_id));
  const clues = await loadSessionClues(todo.map(t => t.s.session_id));

  // Judge in batches of sessions that share the same use cases.
  const verdicts = new Map<string, { ids: string[]; why: string | null; judged: boolean }>();
  const groups = new Map<string, typeof todo>();
  for (const t of todo) {
    const g = groups.get(t.key) ?? [];
    g.push(t);
    groups.set(t.key, g);
  }
  const client = apiKey ? createAnthropicClient(apiKey, { timeoutMs: LONG_AI_CALL_TIMEOUT_MS }) : null;
  const off = thinkingOff(model);
  outer: for (const group of groups.values()) {
    const cands = group[0].cands.map(c => c.cand);
    const readable = group.filter(t => (prompts.get(t.s.session_id)?.length ?? 0) > 0 && cands.length > 0);
    for (const t of group) if (!readable.includes(t)) verdicts.set(t.s.session_id, { ids: [], why: null, judged: false });
    if (!client) {
      for (const t of readable) verdicts.set(t.s.session_id, { ids: [], why: null, judged: false });
      continue;
    }
    for (let i = 0; i < readable.length; i += JUDGE_BATCH) {
      const batch = readable.slice(i, i + JUDGE_BATCH);
      const user = buildJudgeMessage(batch[0].s.dept, cands, batch.map(t => ({
        surface: t.s.surface, prompts: prompts.get(t.s.session_id) ?? [], tools: tools.get(t.s.session_id) ?? [],
        clues: formatClues(clues.get(t.s.session_id)),
      })));
      let text: string;
      try {
        const res = await queueAiCall(() => client.messages.create({
          model, max_tokens: JUDGE_MAX_TOKENS, system: JUDGE_SYSTEM, messages: [{ role: 'user', content: user }],
          output_config: { format: { type: 'json_schema', schema: JUDGE_SCHEMA }, ...(off.effort ? { effort: off.effort } : {}) },
          ...(off.thinking ? { thinking: off.thinking } : {}),
        }));
        if (res.stop_reason === 'max_tokens') { result.failedBatches++; continue; }
        text = extractText(res);
      } catch (err) {
        result.apiError = err instanceof Error ? err.message : String(err);
        break outer;
      }
      const parsed = parseJudgeReply(text, cands, batch.length);
      if (!parsed) { result.failedBatches++; continue; }
      batch.forEach((t, k) => {
        const v = parsed[k];
        if (v) verdicts.set(t.s.session_id, { ids: v.ids, why: stripIdentity(v.why).slice(0, REASON_CHARS) || null, judged: true });
      });
    }
  }

  // Write: the judgement row first (week recounts read its prompt count), then the weekly matches.
  const touched = new Map<string, Set<number>>();
  const touch = (uc: string, wk: number) => { const s = touched.get(uc) ?? new Set<number>(); s.add(wk); touched.set(uc, s); };
  const db = await getTypedClient();
  const jt = schema.useCaseSessionJudgements;
  for (const t of todo) {
    const v = verdicts.get(t.s.session_id);
    // Not reached (API error stopped the run) or an unreadable batch: leave it for the next run.
    if (!v) continue;
    const candIds = new Set(t.cands.map(c => c.uc.id));
    const sessionTools = tools.get(t.s.session_id) ?? [];
    const skillIds = t.cands
      .filter(c => c.skillName && sessionTools.some(name => isCodifiedSkill(c.skillName!, name)))
      .map(c => c.uc.id);
    // Judged sessions take the model's answer; a session that could not be judged
    // (content off, no readable prompt) keeps its earlier judged answer, still
    // limited to the use cases it is judged against now.
    const judgedIds = v.judged ? v.ids : parseIds(t.s.j_ids).filter(id => candIds.has(id));
    const next = [...new Set([...judgedIds, ...skillIds])].filter(id => candIds.has(id));
    const wk = weekStart(t.s.first_at);
    const row = {
      surface: t.s.surface,
      user_id: t.s.user_id,
      department: t.s.dept,
      use_case_ids: JSON.stringify(judgedIds),
      skill_matched_ids: JSON.stringify(skillIds),
      reason: v.judged ? v.why : null,
      candidate_key: t.key,
      prompt_count: prompts.get(t.s.session_id)?.length ?? 0,
      first_event_at: t.s.first_at,
      last_event_at: t.s.last_at,
      model: v.judged ? model : null,
      judged_at: nowS,
    };
    await db.insert(jt).values({ session_id: t.s.session_id, ...row })
      .onConflictDoUpdate({ target: jt.session_id, set: row });
    for (const uc of t.prev.filter(id => !next.includes(id))) {
      for (const w of await removeSessionMatches(uc, t.s.session_id)) touch(uc, w);
    }
    for (const uc of next) {
      await addSessionMatch(uc, wk, t.s.user_id, t.s.session_id);
      touch(uc, wk);
    }
    if (v.judged) result.judged++;
    if (next.length) result.matchedSessions++;
  }

  // New matches change a use case's adoption stage: ask the next scheduler
  // cycle to refresh it, so a just-confirmed use case does not show its
  // sessions beside "Not seen" until the hourly tracker run.
  if (touched.size > 0) await setConfigValue('useCasesTrackerLastRun', '');

  // Recount each touched week, oldest first per use case (the impact rollup
  // attributes a straddling session to its earliest week).
  for (const [uc, weeks] of touched) {
    for (const wk of [...weeks].sort((a, b) => a - b)) {
      try {
        await refreshWeekFromJunction(uc, wk);
        await recomputeWeekImpact(uc, wk);
      } catch (err) {
        console.error(`[UseCaseJudge] week recount failed for ${uc}/${wk}:`, err instanceof Error ? err.message : err);
      }
    }
  }
  return result;
}
