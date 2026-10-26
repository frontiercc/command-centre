// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Developer Pulse session-digest classifier — the OPT-IN judged layer.
 *
 * Design (recorded in CODE-PULSE-PRODUCT-OVERVIEW.md → Measuring Success):
 *  - Classifies the deterministic SESSION DIGEST once per ended session,
 *    never individual messages. The unit of work in code is the session.
 *  - Off by default (config: code_classifier_enabled). Results live in their
 *    own table and are labelled "judged" wherever they surface — the
 *    deterministic spine is never contaminated.
 *  - The digest is metadata (repo, duration, counts, skills, models, commits).
 *    The first user prompt is included for intent ONLY when
 *    code_classifier_include_prompt is true (default) — set it false for a
 *    fully metadata-only privacy posture.
 *
 * Async Drizzle on Postgres, following the blessed query pattern. None of
 * these queries uses an explicit transaction, so writes are per-statement
 * autocommit.
 */
import { createAnthropicClient } from '@/lib/anthropic/client';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue } from '@/lib/config';
import { getCodeClassifierConfig, buildCodeClassifierSystemMessage } from '@/lib/pulse/code/tier-config';
import { parseHumanMinutes, tierGetsEstimate, CODE_ESTIMATE_ONLY_SYSTEM, type HumanMinutes } from '@/lib/pulse/human-time';
import { humanTimeOn } from '@/lib/pulse/human-time-flags';
import { fenceUntrusted } from '@/lib/anthropic/untrusted';
import { redactPii } from '@/lib/pii/detect';

export const WORK_TYPES = [
  'feature', 'bugfix', 'refactor', 'testing',
  'documentation', 'infrastructure', 'exploration', 'other',
] as const;
export type WorkType = typeof WORK_TYPES[number];

const BATCH_SIZE = 20;
const SESSION_QUIET_SECONDS = 30 * 60; // classify final only sessions idle ≥ 30 min
const PROVISIONAL_MIN_AGE_SECONDS = 2 * 60 * 60; // only provisionally classify sessions running ≥ 2h
const MAX_ATTEMPTS = 5; // mirrors lib/pulse/classifier.ts's Cowork MAX_ATTEMPTS

/**
 * Single source of truth for "what counts as a classifier candidate" —
 * shared by runCodeClassifierJob's three passes AND getClassifierQueueDepth
 * below. A queue-depth counter built from a SEPARATE hand-rolled predicate
 * drifted from the job in an earlier release (phantom "N unclassified / Run-now
 * classifies 0"); extracting the predicates here makes that drift
 * structurally impossible — both callers read the exact same conditions.
 */
export function classifierCandidateWhere(
  css: typeof schema.codeSessionStats,
  csc: typeof schema.codeSessionClassifications,
  now: number,
) {
  const cutoff = now - SESSION_QUIET_SECONDS;
  // A session qualifies for pass 1/2 when it has no classification row yet
  // (isNull, via the LEFT JOIN) OR its row failed with attempts still under
  // the ceiling — a failure is retried rather than being permanent, matching
  // Cowork's behaviour (lib/pulse/classifier.ts). "Retried" can mean the
  // very next PASS within the same drain, not necessarily the next
  // scheduled run — a row a model omits from its response can burn all 5
  // attempts within one drain (each pass re-selects it, since it's still
  // ordered to the front of the candidate set), which is a deliberate
  // consequence of retrying at the pass level rather than the run level.
  const notYetClassified = or(
    isNull(csc.session_id),
    and(eq(csc.status, 'failed'), lt(csc.attempts, MAX_ATTEMPTS)),
  );
  return {
    // Pass 1 — final: ended (idle ≥ 30 min), rolled-up, never classified
    // (or retryable-failed), real activity.
    final: and(
      notYetClassified,
      lt(css.last_at, cutoff),
      or(gt(css.assistant_turns, 0), gt(css.user_msg_count, 0)),
    ),
    // Pass 2 — provisional: still active but long-running (≥ 2h), never
    // classified (or retryable-failed).
    provisional: and(
      notYetClassified,
      gte(css.last_at, cutoff),
      lt(css.first_at, now - PROVISIONAL_MIN_AGE_SECONDS),
      or(gt(css.assistant_turns, 0), gt(css.user_msg_count, 0)),
    ),
    // Pass 3 — finalise: has a provisional classification and has gone idle
    // with new activity since it was provisionally classified.
    finalise: and(
      eq(csc.provisional, 1),
      lt(css.last_at, cutoff),
      gt(css.last_at, csc.classified_at),
    ),
  };
}

/**
 * Queue depth — counts each candidate set with the SAME conditions the job
 * uses (via classifierCandidateWhere), no BATCH_SIZE limit. This is what the
 * Classifier Health admin tab surfaces; it is provably in sync with what
 * runCodeClassifierJob will actually classify on its next run.
 */
export async function getClassifierQueueDepth(nowS?: number): Promise<{
  final: number;
  provisional: number;
  finalise: number;
  total: number;
}> {
  const now = nowS ?? Math.floor(Date.now() / 1000);
  const client = await getTypedClient();
  const css = schema.codeSessionStats;
  const csc = schema.codeSessionClassifications;
  const w = classifierCandidateWhere(css, csc, now);

  const countWith = async (join: 'left' | 'inner', where: ReturnType<typeof and>) => {
    const q = client.select({ c: sql<number | string>`COUNT(*)` }).from(css);
    const joined = join === 'inner'
      ? q.innerJoin(csc, eq(csc.session_id, css.session_id))
      : q.leftJoin(csc, eq(csc.session_id, css.session_id));
    const rows = await joined.where(where);
    return Number(rows[0]?.c ?? 0);
  };

  const final = await countWith('left', w.final);
  const provisional = await countWith('left', w.provisional);
  const finalise = await countWith('inner', w.finalise);
  return { final, provisional, finalise, total: final + provisional + finalise };
}

export interface SessionDigestRow {
  session_id: string;
  user_id: string | null;
  repo: string | null;
  git_branch: string | null;
  first_at: number;
  last_at: number;
  user_msg_count: number;
  assistant_turns: number;
  tool_use_count: number;
  error_count: number;
  commit_count: number;
  input_tokens: number;
  output_tokens: number;
  skills_json: string | null;
  mcp_json: string | null;
  models_json: string | null;
}

// ─── Digest + prompt builders (pure, unit-tested) ───────────────────────────

/** Extra evidence for the by-hand estimate; only passed when Code human time is on. */
export interface HumanTimeEvidence {
  linesAdded: number;
  linesRemoved: number;
  pullRequests: number;
  /** Prompts after the first, oldest first, at most LATER_PROMPTS of them. */
  laterPrompts: string[];
}

export const LATER_PROMPTS = 5;
const LATER_PROMPT_CHARS = 300;

export function buildSessionDigest(row: SessionDigestRow, firstPrompt: string | null, evidence?: HumanTimeEvidence): string {
  const mins = Math.max(1, Math.round((row.last_at - row.first_at) / 60));
  let skills: string[] = [];
  let mcp: string[] = [];
  let models: string[] = [];
  try { skills = (JSON.parse(row.skills_json || '[]') as Array<{ name: string }>).map(s => s.name); } catch { /* ignore */ }
  try { mcp = JSON.parse(row.mcp_json || '[]') as string[]; } catch { /* ignore */ }
  try { models = Object.keys(JSON.parse(row.models_json || '{}') as Record<string, unknown>); } catch { /* ignore */ }

  const lines = [
    `session_id: ${row.session_id}`,
    `repo: ${row.repo ?? 'unknown'}${row.git_branch && row.git_branch !== 'HEAD' ? ` (branch: ${row.git_branch})` : ''}`,
    `duration_minutes: ${mins}`,
    `human_prompts: ${row.user_msg_count}`,
    // One row per model call (a prompt makes several), so this
    // is a model-call count; prompts are human_prompts above.
    `model_calls: ${row.assistant_turns}`,
    `tool_actions: ${row.tool_use_count}`,
    `failed_tool_actions: ${row.error_count}`,
    `git_commits_made: ${row.commit_count}`,
    `skills_invoked: ${skills.length ? skills.join(', ') : 'none'}`,
    `connectors_used: ${mcp.length ? mcp.join(', ') : 'none'}`,
    `models: ${models.length ? models.join(', ') : 'unknown'}`,
  ];
  if (firstPrompt) {
    // Masked (item 11) and fenced (item 10) — the only person-written text in
    // an otherwise metadata-only digest.
    lines.push('first_prompt:');
    lines.push(fenceUntrusted(redactPii(firstPrompt.slice(0, 200))));
  }
  if (evidence) {
    lines.push(`lines_added: ${evidence.linesAdded}`);
    lines.push(`lines_removed: ${evidence.linesRemoved}`);
    lines.push(`pull_requests: ${evidence.pullRequests}`);
    if (evidence.laterPrompts.length) {
      // Masked and fenced exactly like first_prompt.
      lines.push('later_prompts:');
      for (const p of evidence.laterPrompts) lines.push(fenceUntrusted(redactPii(p.slice(0, LATER_PROMPT_CHARS))));
    }
  }
  return lines.join('\n');
}

export interface ApiSessionClassification {
  session_id: string;
  work_type: string;
  tier: number;
  confidence: number;
  human_minutes?: unknown;
}

/** Hardened JSON extraction — same strategy as the Cowork classifier. */
export function parseClassifierResponse(rawText: string): ApiSessionClassification[] {
  let cleaned = rawText.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  } else {
    const start = cleaned.indexOf('[');
    if (start > 0) cleaned = cleaned.slice(start);
  }
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function normaliseWorkType(value: string, accepted: readonly string[]): string {
  return accepted.includes(value) ? value : 'other';
}

// ─── Job ─────────────────────────────────────────────────────────────────────

export async function runCodeClassifierJob(): Promise<{ selected: number; classified: number; failed: number; apiError?: string }> {
  if ((await getConfigValue('codePulseEnabled')) === 'false') return { selected: 0, classified: 0, failed: 0 };
  if ((await getConfigValue('codeClassifierEnabled')) === 'false') return { selected: 0, classified: 0, failed: 0 };

  const apiKey = await getConfigValue('anthropicAiApiKey');
  if (!apiKey) {
    console.log('[CodeClassifier] No AI API key configured, skipping');
    return { selected: 0, classified: 0, failed: 0 };
  }

  const client = await getTypedClient();
  const now = Math.floor(Date.now() / 1000);
  const model = (await getConfigValue('codeClassifierModel')) || 'claude-haiku-4-5-20251001';
  const includePrompt = (await getConfigValue('codeClassifierIncludePrompt')) !== 'false';
  const humanTime = await humanTimeOn('code');

  const css = schema.codeSessionStats;
  const csc = schema.codeSessionClassifications;
  const cutoff = now - SESSION_QUIET_SECONDS;
  const candidateWhere = classifierCandidateWhere(css, csc, now);

  const digestCols = {
    session_id: css.session_id,
    user_id: css.user_id,
    repo: css.repo,
    git_branch: css.git_branch,
    first_at: css.first_at,
    last_at: css.last_at,
    user_msg_count: css.user_msg_count,
    assistant_turns: css.assistant_turns,
    tool_use_count: css.tool_use_count,
    error_count: css.error_count,
    commit_count: css.commit_count,
    input_tokens: css.input_tokens,
    output_tokens: css.output_tokens,
    skills_json: css.skills_json,
    mcp_json: css.mcp_json,
    models_json: css.models_json,
  };

  // Pass 1 — final: ended (idle ≥ 30 min), rolled-up, never classified, real activity.
  const finalRows = (await client
    .select(digestCols)
    .from(css)
    .leftJoin(csc, eq(csc.session_id, css.session_id))
    .where(candidateWhere.final)
    .orderBy(desc(css.last_at))
    .limit(BATCH_SIZE)) as SessionDigestRow[];

  // Pass 2 — provisional: still active (last_at within the idle window) but
  // long-running (started ≥ 2h ago) and never classified. Gives long sessions
  // an early, clearly-flagged read instead of waiting for them to go idle.
  const provisionalRows = (await client
    .select(digestCols)
    .from(css)
    .leftJoin(csc, eq(csc.session_id, css.session_id))
    .where(candidateWhere.provisional)
    .orderBy(asc(css.first_at))
    .limit(BATCH_SIZE)) as SessionDigestRow[];

  // Pass 3 — finalise: sessions that only have a provisional classification
  // and have since gone idle. Only re-classify if new activity happened AFTER
  // the provisional pass — otherwise the digest is unchanged and we'd be
  // paying for an identical classification (double-billing the classifier).
  const finaliseRows = (await client
    .select(digestCols)
    .from(css)
    .innerJoin(csc, eq(csc.session_id, css.session_id))
    .where(candidateWhere.finalise)
    .orderBy(desc(css.last_at))
    .limit(BATCH_SIZE)) as SessionDigestRow[];

  // Tag each row with which pass produced it — determines the `provisional`
  // flag written on upsert. finalRows and finaliseRows both resolve to
  // provisional=0. Before the retry-admitting change to `notYetClassified`,
  // a session could never appear in more than one pass's result set
  // (finalRows required no classification row at all, finaliseRows required
  // one); a retried, provisionally-failed session that goes idle again with
  // new activity can now satisfy BOTH final and finalise in the same run —
  // the de-duplication below (`seenSessionIds`) is what keeps it processed
  // exactly once.
  // Pass 4 — stranded finalisation: sessions that were classified provisional
  // and then never saw another event. A provisional row's classified_at is
  // set to "now" at write time, which is >= the session's last_at at that
  // moment — so `last_at > classified_at` (pass 3's condition) can never
  // become true for a session with no further activity, and it would stay
  // provisional forever. Once such a session is idle past the quiet window,
  // the digest is unchanged from what was already classified, so this is a
  // cheap SQL-only flip — no Anthropic call, no re-billing.
  await client
    .update(csc)
    .set({ provisional: 0 })
    .where(sql`
      ${csc.provisional} = 1
      AND ${csc.session_id} IN (
        SELECT css2.session_id FROM code_session_stats css2
        WHERE css2.last_at < ${cutoff}
          AND css2.last_at <= (
            SELECT csc2.classified_at FROM code_session_classifications csc2
            WHERE csc2.session_id = css2.session_id
          )
      )
    `);

  // De-duplicate by session_id, keeping the first occurrence (finalRows
  // wins over finaliseRows). A session can satisfy BOTH final's
  // retry-admission (a provisional classification that failed, is retried
  // via the failed-attempts branch below MAX_ATTEMPTS) AND finalise's own
  // condition (provisional=1, idle, new activity since the failed attempt)
  // in the same run — without this, it would be selected, classified, and
  // have its `attempts` incremented TWICE in one pass. Keeping the
  // finalRows copy is correct either way: provisionalSessionIds (below) is
  // built only from provisionalRows, so this session's write still
  // resolves provisional=0 — the right outcome once a session has gone
  // idle, whichever pass "claims" it here.
  const seenSessionIds = new Set<string>();
  const rows: SessionDigestRow[] = [...finalRows, ...provisionalRows, ...finaliseRows].filter(r => {
    if (seenSessionIds.has(r.session_id)) return false;
    seenSessionIds.add(r.session_id);
    return true;
  });
  const provisionalSessionIds = new Set(provisionalRows.map(r => r.session_id));

  if (rows.length === 0) return { selected: 0, classified: 0, failed: 0 };

  // First prompt per session (intent context) — only when configured
  const cm = schema.coworkMessages;
  const firstPrompts = new Map<string, string>();
  if (includePrompt) {
    for (const r of rows) {
      const promptRows = await client
        .select({ content_preview: cm.content_preview })
        .from(cm)
        .where(and(eq(cm.session_id, r.session_id), eq(cm.surface, 'code'), eq(cm.message_type, 'code_user_message')))
        .orderBy(asc(cm.occurred_at))
        .limit(1);
      const p = promptRows[0];
      if (p?.content_preview) firstPrompts.set(r.session_id, p.content_preview);
    }
  }

  const evidence = humanTime ? await gatherHumanTimeEvidence(client, rows.map(r => r.session_id), includePrompt) : null;
  const digests = rows.map(r => buildSessionDigest(r, firstPrompts.get(r.session_id) ?? null, evidence?.get(r.session_id)));

  const anthropicClient = createAnthropicClient(apiKey);
  const classifierConfig = await getCodeClassifierConfig();
  let items: ApiSessionClassification[] = [];
  let batchError: string | null = null;
  let apiError: string | undefined;
  try {
    const response = await anthropicClient.messages.create({
      model,
      max_tokens: 4096,
      system: buildCodeClassifierSystemMessage(classifierConfig, { humanTime }),
      messages: [{ role: 'user', content: `Classify these ${rows.length} sessions:\n\n${digests.join('\n\n---\n\n')}` }],
    });
    const textBlock = response.content.find(b => b.type === 'text');
    items = parseClassifierResponse(textBlock?.type === 'text' ? textBlock.text : '');
    if (items.length === 0) batchError = 'Empty or unparseable classifier response';
  } catch (err) {
    batchError = err instanceof Error ? err.message : String(err);
    apiError = batchError;
  }

  const byId = new Map(items.map(i => [String(i.session_id), i]));
  const acceptedWorkTypes = classifierConfig.workTypes.map(w => w.name).filter(Boolean);
  const acceptedSet = acceptedWorkTypes.length ? acceptedWorkTypes : (WORK_TYPES as readonly string[]);

  let classified = 0;
  let failed = 0;
  for (const r of rows) {
    const item = byId.get(r.session_id);
    const provisional = provisionalSessionIds.has(r.session_id) ? 1 : 0;
    if (item && !batchError) {
      const tier = [1, 2, 3].includes(item.tier) ? item.tier : 1;
      const workType = normaliseWorkType(String(item.work_type), acceptedSet);
      const confidence = Math.max(0, Math.min(1, Number(item.confidence) || 0));
      // Flag off: the estimate columns are not written at all, so nothing changes.
      const est: HumanMinutes | null = humanTime && tierGetsEstimate(tier) ? parseHumanMinutes(item.human_minutes) : null;
      const values = {
        user_id: r.user_id, work_type: workType, tier, confidence,
        classifier_model: model, status: 'classified', error: null,
        classified_at: now, provisional,
        ...(humanTime ? {
          human_minutes_low: est?.low ?? null,
          human_minutes_likely: est?.likely ?? null,
          human_minutes_high: est?.high ?? null,
        } : {}),
      };
      // ON CONFLICT upsert — pass 3 (finalise) targets a session_id that
      // already has a provisional row; this replaces it in place with
      // provisional=0 rather than requiring a delete-then-insert.
      await client
        .insert(csc)
        .values({ session_id: r.session_id, ...values })
        .onConflictDoUpdate({ target: csc.session_id, set: values });
      classified++;
    } else {
      const values = {
        user_id: r.user_id, work_type: 'other' as const, tier: 1, confidence: 0,
        classifier_model: model, status: 'failed',
        error: batchError ?? 'Session missing from classifier response',
        classified_at: now, provisional,
      };
      // A fresh insert relies on the column's DEFAULT 1 for the first
      // attempt; the conflict path increments the existing row's count —
      // mirrors lib/pulse/classifier.ts's Cowork classifier_attempts + 1.
      await client
        .insert(csc)
        .values({ session_id: r.session_id, ...values })
        .onConflictDoUpdate({
          target: csc.session_id,
          set: { ...values, attempts: sql`${csc.attempts} + 1` },
        });
      failed++;
    }
  }

  console.log(`[CodeClassifier] ${classified} classified, ${failed} failed (batch of ${rows.length})`);
  return apiError ? { selected: rows.length, classified, failed, apiError } : { selected: rows.length, classified, failed };
}

/**
 * Lines changed, pull requests and later prompts per session, for the by-hand
 * estimate. Lines and PRs come from the session's own OTel metric rows. Later
 * prompts respect codeClassifierIncludePrompt; retention-stripped text is skipped.
 */
export async function gatherHumanTimeEvidence(
  client: Awaited<ReturnType<typeof getTypedClient>>,
  sessionIds: string[],
  includePrompts: boolean,
): Promise<Map<string, HumanTimeEvidence>> {
  const out = new Map<string, HumanTimeEvidence>();
  for (const id of sessionIds) out.set(id, { linesAdded: 0, linesRemoved: 0, pullRequests: 0, laterPrompts: [] });
  if (sessionIds.length === 0) return out;
  const m = schema.codeOtelMetrics;
  const metricRows = await client
    .select({ session_id: m.session_id, metric_name: m.metric_name, type: m.type, total: sql<number>`sum(${m.value})` })
    .from(m)
    .where(and(inArray(m.session_id, sessionIds),
      inArray(m.metric_name, ['claude_code.lines_of_code.count', 'claude_code.pull_request.count'])))
    .groupBy(m.session_id, m.metric_name, m.type);
  for (const r of metricRows) {
    const e = out.get(String(r.session_id));
    if (!e) continue;
    const n = Math.round(Number(r.total) || 0);
    if (r.metric_name === 'claude_code.pull_request.count') e.pullRequests += n;
    else if (r.type === 'added') e.linesAdded += n;
    else if (r.type === 'removed') e.linesRemoved += n;
  }
  if (includePrompts) {
    const cm = schema.coworkMessages;
    for (const id of sessionIds) {
      const prompts = await client
        .select({ text: cm.content_preview })
        .from(cm)
        .where(and(eq(cm.session_id, id), eq(cm.surface, 'code'), eq(cm.message_type, 'code_user_message')))
        .orderBy(asc(cm.occurred_at))
        .offset(1)
        .limit(LATER_PROMPTS);
      out.get(id)!.laterPrompts = prompts.map(p => p.text).filter((t): t is string => !!t && !t.startsWith('[Content removed'));
    }
  }
  return out;
}

/**
 * Backfill: estimate by-hand time for already-classified
 * Tier 2/3 Code sessions that have none. Writes ONLY the three estimate
 * columns: tier, work type and every other column are never touched, so no
 * history is reclassified. `skip` holds ids already tried in this run, so a
 * session whose reply is refused is not retried in a loop, and every try counts
 * an attempt (3 at most) so the scheduled backlog pass gives up on it too.
 * `sinceS` limits it to recent sessions (the scheduler passes 30 days).
 */
export async function estimateClassifiedCodeSessions(
  skip: ReadonlySet<string>,
  deps?: { callModel?: (system: string, user: string) => Promise<string> },
  opts: { sinceS?: number } = {},
): Promise<{ attempted: string[]; written: number; apiError?: string }> {
  const client = await getTypedClient();
  const css = schema.codeSessionStats;
  const csc = schema.codeSessionClassifications;
  const candidates = (await client
    .select({
      session_id: css.session_id, user_id: css.user_id, repo: css.repo, git_branch: css.git_branch,
      first_at: css.first_at, last_at: css.last_at, user_msg_count: css.user_msg_count,
      assistant_turns: css.assistant_turns, tool_use_count: css.tool_use_count, error_count: css.error_count,
      commit_count: css.commit_count, input_tokens: css.input_tokens, output_tokens: css.output_tokens,
      skills_json: css.skills_json, mcp_json: css.mcp_json, models_json: css.models_json,
    })
    .from(css)
    .innerJoin(csc, eq(csc.session_id, css.session_id))
    .where(and(eq(csc.status, 'classified'), inArray(csc.tier, [2, 3]), isNull(csc.human_minutes_likely),
      lt(csc.human_minutes_attempts, 3), ...(opts.sinceS ? [gte(css.first_at, opts.sinceS)] : [])))
    .orderBy(desc(css.last_at))
    .limit(BATCH_SIZE + skip.size)) as SessionDigestRow[];
  const rows = candidates.filter(r => !skip.has(r.session_id)).slice(0, BATCH_SIZE);
  if (rows.length === 0) return { attempted: [], written: 0 };

  const includePrompt = (await getConfigValue('codeClassifierIncludePrompt')) !== 'false';
  const cm = schema.coworkMessages;
  const firstPrompts = new Map<string, string>();
  if (includePrompt) {
    for (const r of rows) {
      const p = await client.select({ content_preview: cm.content_preview }).from(cm)
        .where(and(eq(cm.session_id, r.session_id), eq(cm.surface, 'code'), eq(cm.message_type, 'code_user_message')))
        .orderBy(asc(cm.occurred_at)).limit(1);
      if (p[0]?.content_preview) firstPrompts.set(r.session_id, p[0].content_preview);
    }
  }
  const evidence = await gatherHumanTimeEvidence(client, rows.map(r => r.session_id), includePrompt);
  const digests = rows.map(r => buildSessionDigest(r, firstPrompts.get(r.session_id) ?? null, evidence.get(r.session_id)));
  const user = `Size these ${rows.length} sessions:\n\n${digests.join('\n\n---\n\n')}`;

  let text: string;
  try {
    if (deps?.callModel) {
      text = await deps.callModel(CODE_ESTIMATE_ONLY_SYSTEM, user);
    } else {
      const apiKey = await getConfigValue('anthropicAiApiKey');
      if (!apiKey) throw new Error('No AI API key configured');
      const model = (await getConfigValue('codeClassifierModel')) || 'claude-haiku-4-5-20251001';
      const response = await createAnthropicClient(apiKey).messages.create({
        model, max_tokens: 4096, system: CODE_ESTIMATE_ONLY_SYSTEM, messages: [{ role: 'user', content: user }],
      });
      const block = response.content.find(b => b.type === 'text');
      text = block?.type === 'text' ? block.text : '';
    }
  } catch (err) {
    return { attempted: [], written: 0, apiError: err instanceof Error ? err.message : String(err) };
  }

  const byId = new Map(parseClassifierResponse(text).map(i => [String(i.session_id), i]));
  let written = 0;
  for (const r of rows) {
    const est = parseHumanMinutes(byId.get(r.session_id)?.human_minutes);
    await client.update(csc)
      .set(est
        ? { human_minutes_low: est.low, human_minutes_likely: est.likely, human_minutes_high: est.high, human_minutes_attempts: sql`${csc.human_minutes_attempts} + 1` }
        : { human_minutes_attempts: sql`${csc.human_minutes_attempts} + 1` })
      .where(eq(csc.session_id, r.session_id));
    if (est) written++;
  }
  return { attempted: rows.map(r => r.session_id), written };
}
