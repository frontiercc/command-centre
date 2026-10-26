// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient } from '@/lib/anthropic/client';
import type { DrainPassResult } from '@/lib/pulse/drain';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { withTx } from '@/lib/db/with-tx';
import { getConfigValue } from '@/lib/config';
import { redactPii } from '@/lib/pii/detect';
import { STRIPPED_MARKER } from '@/lib/retention/cleanup';
import {
  buildClassifierSystemMessage,
  buildClassifierUserMessage,
  getTierConfig,
  type ClassifierEvent,
  type UserHistory,
} from '@/lib/pulse/prompts/tier-classification';

// ─── Phase 3 raw-execution facade (mirrors lib/db/queries.ts's rawAll) ────────
// Reserved for the one query below that's clearer as raw SQL (a NOT IN
// subquery + ORDER BY + LIMIT) than built via the query builder.
interface RawFacade {
  execute: (q: unknown) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}
async function rawAll<T>(client: unknown, query: unknown): Promise<T[]> {
  const c = client as RawFacade;
  const res = await c.execute(query);
  return res.rows as T[];
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CoworkMessageRow {
  id: string;
  user_id: string;
  session_id: string | null;
  content_full: string | null;
  content_preview: string | null;
  tool_name: string | null;
  occurred_at: number;
}

export interface ClassificationResult {
  cowork_message_id: string;
  user_id: string;
  tier: 1 | 2 | 3;
  task_type: string;
  frontier_push_candidate: boolean;
  capability_creation_candidate: boolean;
  classifier_confidence: number;
  classifier_model: string;
  classifier_status: 'classified' | 'failed';
  classifier_attempts: number;
  classifier_error: string | null;
  classified_at: number;
}

interface ApiClassificationItem {
  event_id: string;
  tier: number;
  task_type: string;
  frontier_push_candidate: boolean;
  capability_creation_candidate: boolean;
  confidence: number;
}

type TypedClient = Awaited<ReturnType<typeof getTypedClient>>;

// ─── Anthropic client ────────────────────────────────────────────────────────

async function getClient(): Promise<Anthropic> {
  const apiKey = await getConfigValue('anthropicAiApiKey');
  if (!apiKey) throw new Error('No AI API key configured');
  return createAnthropicClient(apiKey);
}

// ─── History lookup ──────────────────────────────────────────────────────────

/**
 * Build the user history map for a set of user IDs.
 * Reads existing pulse_classifications rows to determine prior tiers,
 * task types, and capability creation counts per user.
 */
async function buildUserHistoryMap(client: TypedClient, userIds: string[]): Promise<Map<string, UserHistory>> {
  const result = new Map<string, UserHistory>();

  if (userIds.length === 0) return result;

  const pc = schema.pulseClassifications;
  const classifiedForUsers = and(inArray(pc.user_id, userIds), eq(pc.classifier_status, 'classified'));

  // Fetch distinct tiers per user
  const tierRows = await client
    .select({ user_id: pc.user_id, tier: pc.tier })
    .from(pc)
    .where(classifiedForUsers);

  // Fetch distinct task_types per user
  const typeRows = await client
    .select({ user_id: pc.user_id, task_type: pc.task_type })
    .from(pc)
    .where(classifiedForUsers);

  // Count confirmed capability_creation_candidate events per user
  const capRows = await client
    .select({ user_id: pc.user_id, cnt: sql<number | string>`COUNT(*)` })
    .from(pc)
    .where(and(inArray(pc.user_id, userIds), eq(pc.capability_creation_candidate, 1), eq(pc.classifier_status, 'classified')))
    .groupBy(pc.user_id);

  // Initialise entries for all requested users
  for (const uid of userIds) {
    result.set(uid, {
      user_id: uid,
      prior_tiers_observed: [],
      prior_task_types_observed: [],
      prior_capability_creation_events: 0,
    });
  }

  for (const row of tierRows) {
    const h = result.get(row.user_id)!;
    if (!h.prior_tiers_observed.includes(row.tier)) {
      h.prior_tiers_observed.push(row.tier);
    }
  }

  for (const row of typeRows) {
    const h = result.get(row.user_id)!;
    if (!h.prior_task_types_observed.includes(row.task_type)) {
      h.prior_task_types_observed.push(row.task_type);
    }
  }

  for (const row of capRows) {
    const h = result.get(row.user_id)!;
    h.prior_capability_creation_events = Number(row.cnt ?? 0);
  }

  return result;
}

// ─── Core classify function ───────────────────────────────────────────────────

/**
 * Classify a batch of cowork_messages rows via the Anthropic API.
 * Returns an array of ClassificationResult objects — one per input row.
 * Rows that could not be parsed from the API response are returned with
 * classifier_status = 'failed'.
 *
 * Does NOT write to the database — caller is responsible for persistence.
 */
/**
 * The judged flags and confidence, checked. A flag
 * is on only for a literal true: Boolean("false") is true, so a string reply
 * must never switch one on. Confidence is clamped to its documented 0–1 range.
 */
export function readJudgedFlags(item: { frontier_push_candidate?: unknown; capability_creation_candidate?: unknown; confidence?: unknown }): {
  frontier_push_candidate: boolean;
  capability_creation_candidate: boolean;
  classifier_confidence: number;
} {
  const c = item.confidence;
  return {
    frontier_push_candidate: item.frontier_push_candidate === true,
    capability_creation_candidate: item.capability_creation_candidate === true,
    classifier_confidence: typeof c === 'number' && Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0,
  };
}

export async function classifyBatch(
  rows: CoworkMessageRow[],
  model: string
): Promise<ClassificationResult[]> {
  const now = Math.floor(Date.now() / 1000);

  // Gather session-level tool context from cowork_mcp_invocations and cowork_skill_invocations.
  // These tables are populated only when the agent is running — gracefully empty for older sessions.
  const sessionIds = [...new Set(rows.map(r => r.session_id).filter(Boolean))] as string[];
  const sessionMcpMap = new Map<string, string[]>();
  const sessionUserTypedSkillMap = new Map<string, string[]>();
  const sessionAgentChainedSkillMap = new Map<string, string[]>();

  const sessionOtelStatsMap = new Map<string, { tool_call_count: number | null; unique_tools: string[]; upload_count: number | null }>();

  // Named dbClient (not client) to avoid colliding with the Anthropic SDK
  // client constructed further down for the actual classification call.
  const dbClient = await getTypedClient();

  if (sessionIds.length > 0) {
    const mcpRows = await dbClient
      .select({ session_id: schema.coworkMcpInvocations.session_id, mcp_server: schema.coworkMcpInvocations.mcp_server })
      .from(schema.coworkMcpInvocations)
      .where(inArray(schema.coworkMcpInvocations.session_id, sessionIds));

    for (const row of mcpRows) {
      const list = sessionMcpMap.get(row.session_id) ?? [];
      if (!list.includes(row.mcp_server)) list.push(row.mcp_server);
      sessionMcpMap.set(row.session_id, list);
    }

    // Query invocation_type to split skills into user-typed vs agent-chained.
    // agent_chained skills are a stronger T3 signal — they indicate Claude is
    // autonomously composing skills as part of agentic work, not just being asked to.
    const skillRows = await dbClient
      .select({
        session_id: schema.coworkSkillInvocations.session_id,
        skill_name: schema.coworkSkillInvocations.skill_name,
        invocation_type: schema.coworkSkillInvocations.invocation_type,
      })
      .from(schema.coworkSkillInvocations)
      .where(inArray(schema.coworkSkillInvocations.session_id, sessionIds));

    for (const row of skillRows) {
      const type = row.invocation_type || 'user_typed';
      if (type === 'agent_chained') {
        const list = sessionAgentChainedSkillMap.get(row.session_id) ?? [];
        if (!list.includes(row.skill_name)) list.push(row.skill_name);
        sessionAgentChainedSkillMap.set(row.session_id, list);
      } else {
        const list = sessionUserTypedSkillMap.get(row.session_id) ?? [];
        if (!list.includes(row.skill_name)) list.push(row.skill_name);
        sessionUserTypedSkillMap.set(row.session_id, list);
      }
    }

    // OTel session stats: tool_call_count, unique_tools, upload_count.
    // Only populated for OTel-sourced sessions; gracefully empty for agent sessions.
    const otelRows = await dbClient
      .select({
        session_id: schema.coworkSessionStats.session_id,
        tool_call_count: schema.coworkSessionStats.tool_call_count,
        unique_tools: schema.coworkSessionStats.unique_tools,
        upload_count: schema.coworkSessionStats.upload_count,
      })
      .from(schema.coworkSessionStats)
      .where(inArray(schema.coworkSessionStats.session_id, sessionIds));

    for (const row of otelRows) {
      let tools: string[] = [];
      if (row.unique_tools) {
        try { tools = JSON.parse(row.unique_tools) as string[]; } catch { /* leave empty */ }
      }
      sessionOtelStatsMap.set(row.session_id, {
        tool_call_count: row.tool_call_count,
        unique_tools: tools,
        upload_count: row.upload_count,
      });
    }
  }

  // Map to ClassifierEvent shape
  const events: ClassifierEvent[] = rows.map(r => {
    const otelStats = r.session_id ? sessionOtelStatsMap.get(r.session_id) : undefined;
    return {
      id: r.id,
      user_id: r.user_id,
      session_id: r.session_id,
      // Personal data is masked before the prompt leaves for the classifier:
      // labelling the depth of delegation never
      // needs the phone number or account number inside it.
      content: redactPii(r.content_full ?? r.content_preview ?? ''),
      tool_name: r.tool_name,
      occurred_at: r.occurred_at,
      mcp_servers: r.session_id ? (sessionMcpMap.get(r.session_id) ?? []) : [],
      user_typed_skills: r.session_id ? (sessionUserTypedSkillMap.get(r.session_id) ?? []) : [],
      agent_chained_skills: r.session_id ? (sessionAgentChainedSkillMap.get(r.session_id) ?? []) : [],
      otel_tool_call_count: otelStats?.tool_call_count ?? null,
      otel_unique_tools: otelStats?.unique_tools ?? [],
      otel_upload_count: otelStats?.upload_count ?? null,
    };
  });

  // Build user history for all users in this batch
  const userIds = [...new Set(rows.map(r => r.user_id))];
  const history = await buildUserHistoryMap(dbClient, userIds);

  const userMessage = buildClassifierUserMessage(events, history);

  const client = await getClient();
  const tierConfig = await getTierConfig();
  // The admin-editable taxonomy is the only source of valid task types, so a
  // rubric edit that renames or adds one is honoured on the next batch without
  // touching this file — same contract as the Code classifier's
  // normaliseWorkType.
  const validTaskTypes = new Set<string>([
    ...tierConfig.taxonomy.tier1,
    ...tierConfig.taxonomy.tier2,
    ...tierConfig.taxonomy.tier3,
  ].map((d) => d.name));
  const response = await client.messages.create({
    model,
    max_tokens: 8192,
    messages: [
      { role: 'user', content: userMessage },
    ],
    system: buildClassifierSystemMessage(tierConfig),
  });

  // Extract text content from the response
  const textBlock = response.content.find(b => b.type === 'text');
  const rawText = textBlock?.type === 'text' ? textBlock.text : '';

  // Parse JSON array from response.
  // Models occasionally wrap the output in markdown fences despite the prompt saying not to.
  // The extraction strategy:
  //   1. Trim leading/trailing whitespace first (handles leading newlines before fences).
  //   2. If a code fence is present anywhere, extract its inner content (handles prose preambles).
  //   3. Otherwise, slice from the first [ or { to strip any non-JSON prefix.
  let parsed: ApiClassificationItem[] = [];
  let cleaned = rawText.trim();
  try {
    const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenceMatch) {
      cleaned = fenceMatch[1].trim();
    } else {
      // No fence — find the first JSON bracket in case there's a prose prefix
      const arrayStart = cleaned.indexOf('[');
      const objStart = cleaned.indexOf('{');
      const start = arrayStart === -1 ? objStart
        : objStart === -1 ? arrayStart
        : Math.min(arrayStart, objStart);
      if (start > 0) cleaned = cleaned.slice(start);
    }
    parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) parsed = [];
  } catch {
    // If parsing fails, all rows in this batch get failed status
    return rows.map(r => ({
      cowork_message_id: r.id,
      user_id: r.user_id,
      tier: 1,
      task_type: 'summarisation',
      frontier_push_candidate: false,
      capability_creation_candidate: false,
      classifier_confidence: 0,
      classifier_model: model,
      classifier_status: 'failed',
      classifier_attempts: 1,
      classifier_error: `JSON parse error: ${rawText.slice(0, 200)}`,
      classified_at: now,
    }));
  }

  // Build a lookup map by event_id
  const resultMap = new Map<string, ApiClassificationItem>(
    parsed.map(item => [String(item.event_id), item])
  );

  return rows.map(r => {
    const item = resultMap.get(r.id);
    if (!item) {
      return {
        cowork_message_id: r.id,
        user_id: r.user_id,
        tier: 1 as const,
        task_type: 'summarisation',
        frontier_push_candidate: false,
        capability_creation_candidate: false,
        classifier_confidence: 0,
        classifier_model: model,
        classifier_status: 'failed' as const,
        classifier_attempts: 1,
        classifier_error: 'Event not returned by API',
        classified_at: now,
      };
    }

    const tier = ([1, 2, 3].includes(item.tier) ? item.tier : 1) as 1 | 2 | 3;

    // The tier above has always been validated; task_type never was, so
    // whatever the model returned was stored verbatim — an off-taxonomy value,
    // free text, anything. Every surface that groups by task_type (Work Mix,
    // the session output rate breakdown, the FinOps activity axis) then carries
    // a category the rubric never defined and no admin can find.
    //
    // An unrecognised value is now a FAILED classification rather than a stored
    // label: it surfaces in Classifier Health, it can be retried, and it never
    // invents a category. Deliberately NOT coerced to a plausible default —
    // guessing would hide the problem while still corrupting the breakdown.
    if (!validTaskTypes.has(item.task_type ?? '')) {
      return {
        cowork_message_id: r.id,
        user_id: r.user_id,
        tier,
        task_type: 'summarisation',
        frontier_push_candidate: false,
        capability_creation_candidate: false,
        classifier_confidence: 0,
        classifier_model: model,
        classifier_status: 'failed' as const,
        classifier_attempts: 1,
        classifier_error: `task_type not in taxonomy: ${JSON.stringify(item.task_type ?? null)}`,
        classified_at: now,
      };
    }

    return {
      cowork_message_id: r.id,
      user_id: r.user_id,
      tier,
      task_type: item.task_type,
      ...readJudgedFlags(item),
      classifier_model: model,
      classifier_status: 'classified' as const,
      classifier_attempts: 1,
      classifier_error: null,
      classified_at: now,
    };
  });
}

// ─── Scheduled job ───────────────────────────────────────────────────────────

const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 5;

/**
 * Run one classification cycle:
 * 1. Fetch up to BATCH_SIZE unclassified cowork_messages rows (surface = 'cowork').
 * 2. Call the Anthropic API in one batch.
 * 3. Write results to pulse_classifications.
 * 4. After MAX_ATTEMPTS failures on the same row, mark it as 'failed'.
 */
export async function runClassifierJob(): Promise<DrainPassResult> {
  const client = await getTypedClient();
  const model = (await getConfigValue('pulseClassifierModel')) || 'claude-haiku-4-5-20251001';

  // Fetch unclassified rows, excluding those that have already failed
  // MAX_ATTEMPTS times. Kept as one raw statement (NOT IN subquery + ORDER BY
  // + LIMIT) — no date bucketing involved (Rule 2). Raw execute
  // bypasses Drizzle's per-column decode, so occurred_at (bigint) needs a
  // manual Number() coercion below (Policy B).
  const rawRows = await rawAll<{
    id: string; user_id: string; session_id: string | null; content_full: string | null;
    content_preview: string | null; tool_name: string | null; occurred_at: number | string;
  }>(client, sql`
     SELECT
       cm.id,
       cm.user_id,
       cm.session_id,
       cm.content_full,
       cm.content_preview,
       cm.tool_name,
       cm.occurred_at
     FROM cowork_messages cm
     WHERE cm.surface = 'cowork'
       AND cm.message_type = 'cowork_user_message'
       -- Never judge a prompt whose text retention has removed: the model
       -- would see only the marker and overwrite a real label with tier 1
       -- summarisation (happened on localhost, 2026-09-26).
       AND COALESCE(cm.content_full, cm.content_preview, '') <> ${STRIPPED_MARKER}
       AND cm.id NOT IN (
         SELECT cowork_message_id FROM pulse_classifications
         WHERE classifier_status = 'classified'
            OR classifier_attempts >= ${MAX_ATTEMPTS}
       )
     ORDER BY cm.occurred_at ASC
     LIMIT ${BATCH_SIZE}
  `);
  const rows: CoworkMessageRow[] = rawRows.map(r => ({ ...r, occurred_at: Number(r.occurred_at) }));

  if (rows.length === 0) return { selected: 0, classified: 0, failed: 0 };

  console.log(`[PulseClassifier] Classifying ${rows.length} rows with model ${model}`);

  let results: ClassificationResult[];
  try {
    results = await classifyBatch(rows, model);
  } catch (err) {
    const apiError = err instanceof Error ? err.message : String(err);
    console.error('[PulseClassifier] API call failed:', apiError);
    // Increment attempt counts for all rows in this batch
    await incrementAttemptCounts(client, rows.map(r => r.id));
    return { selected: rows.length, classified: 0, failed: rows.length, apiError };
  }

  // Persist results — an all-or-nothing batch upsert (matches the original
  // db.transaction(...) semantics exactly: one failure aborts the whole
  // batch). withTx (not savepointEach) is the correct primitive here per the
  // brief — this is NOT the error-tolerant-per-row case savepointEach exists
  // for.
  const pc = schema.pulseClassifications;
  await withTx(client, async (tx) => {
    for (const r of results) {
      await tx
        .insert(pc)
        .values({
          cowork_message_id: r.cowork_message_id,
          user_id: r.user_id,
          tier: r.tier,
          task_type: r.task_type,
          frontier_push_candidate: r.frontier_push_candidate ? 1 : 0,
          capability_creation_candidate: r.capability_creation_candidate ? 1 : 0,
          classifier_confidence: r.classifier_confidence,
          classifier_model: r.classifier_model,
          classifier_status: r.classifier_status,
          classifier_attempts: r.classifier_attempts,
          classifier_error: r.classifier_error,
          classified_at: r.classified_at,
        })
        .onConflictDoUpdate({
          target: pc.cowork_message_id,
          set: {
            tier: r.tier,
            task_type: r.task_type,
            frontier_push_candidate: r.frontier_push_candidate ? 1 : 0,
            capability_creation_candidate: r.capability_creation_candidate ? 1 : 0,
            classifier_confidence: r.classifier_confidence,
            classifier_model: r.classifier_model,
            classifier_status: r.classifier_status,
            classifier_attempts: sql`${pc.classifier_attempts} + 1`,
            classifier_error: r.classifier_error,
            classified_at: r.classified_at,
          },
        });
    }
  });

  const classified = results.filter(r => r.classifier_status === 'classified').length;
  const failed = results.filter(r => r.classifier_status === 'failed').length;
  console.log(`[PulseClassifier] Done. classified=${classified} failed=${failed}`);
  return { selected: rows.length, classified, failed };
}

/**
 * Increment attempt counts for rows that failed at the API call level
 * (i.e. the whole batch failed, not individual rows).
 *
 * The original raw SQL used `INSERT ... SELECT id, user_id, ... FROM
 * cowork_messages WHERE id = ?` to source user_id from the message row
 * itself, so a since-deleted message id was silently a no-op. Drizzle's
 * `.values()` needs literal values, not a correlated SELECT, so this fetches
 * the user_ids in one batched query first and skips any id no longer present
 * in cowork_messages (the same no-op behaviour). All-or-nothing across the
 * batch is preserved via withTx, exactly as the original db.transaction(...).
 */
async function incrementAttemptCounts(client: TypedClient, messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return;
  const now = Math.floor(Date.now() / 1000);

  const cm = schema.coworkMessages;
  const msgRows = await client
    .select({ id: cm.id, user_id: cm.user_id })
    .from(cm)
    .where(inArray(cm.id, messageIds));
  const userIdByMsgId = new Map(msgRows.map(r => [r.id, r.user_id] as const));

  const pc = schema.pulseClassifications;
  await withTx(client, async (tx) => {
    for (const id of messageIds) {
      const userId = userIdByMsgId.get(id);
      if (userId === undefined || userId === null) continue; // message no longer exists — matches the original SELECT-yields-nothing no-op
      await tx
        .insert(pc)
        .values({
          cowork_message_id: id,
          user_id: userId,
          tier: 1,
          task_type: 'summarisation',
          frontier_push_candidate: 0,
          capability_creation_candidate: 0,
          classifier_confidence: 0,
          classifier_model: 'unknown',
          classifier_status: 'failed',
          classifier_attempts: 1,
          classifier_error: 'API call failed',
          classified_at: now,
        })
        .onConflictDoUpdate({
          target: pc.cowork_message_id,
          set: {
            classifier_attempts: sql`${pc.classifier_attempts} + 1`,
            classifier_error: 'API call failed',
            classifier_status: sql`CASE WHEN ${pc.classifier_attempts} + 1 >= ${MAX_ATTEMPTS} THEN 'failed' ELSE ${pc.classifier_status} END`,
            classified_at: now,
          },
        });
    }
  });
}
