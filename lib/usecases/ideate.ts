// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Ideation chatbot (Phase 1) — brainstorm candidate AI use cases grounded
 * ONLY in the customer's own CCC telemetry.
 *
 * DECISION (spec): no external/benchmark/catalog suggestions. Every idea the
 * model proposes must trace back to org grounding data gathered here (top
 * skills, underused connectors, top task types, departments) — never
 * industry-generic "companies like yours" suggestions.
 *
 * Never persists — the caller (API route) returns the reply + candidates for
 * review; the UI persists a chosen candidate on user confirmation via
 * POST /api/use-cases.
 *
 * gatherOrgGrounding():
 * the four GROUP BY aggregates stay raw SQL via `rawAll` (clearer as raw than
 * a Drizzle groupBy/orderBy chain, per the blessed pattern); the departments
 * lookup uses the typed query builder's selectDistinct.
 */
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient } from '@/lib/anthropic/client';
import { and, isNotNull, ne, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getConfigValue } from '@/lib/config';
import { extractText, stripCodeFences, parseModelJson } from '@/lib/anthropic/constants';
import { queueAiCall } from '@/lib/ingestion/scheduler';

export interface OrgGrounding {
  topSkills: string[];
  underusedConnectors: string[];
  topTaskTypes: string[];
  codeWorkTypes: string[];
  departments: string[];
}

export interface IdeateCandidate {
  title: string;
  description: string;
  keywords?: string[];
  sourceExcerpt?: string;
}

export interface IdeateTurnResult {
  reply: string;
  candidates: IdeateCandidate[];
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type IdeateMode = 'scratch' | 'telemetry';

/** MCP servers that are part of the platform itself, not a "connector" a user chose to adopt. */
const SYSTEM_MCP_SERVERS = new Set(['workspace', 'cowork', 'Claude_in_Chrome']);

const TOP_SKILLS_LIMIT = 10;
const TOP_TASK_TYPES_LIMIT = 10;
const UNDERUSED_CONNECTORS_LIMIT = 10;
const CODE_WORK_TYPES_LIMIT = 10;

async function getClient(): Promise<Anthropic> {
  const apiKey = await getConfigValue('anthropicAiApiKey');
  if (!apiKey) throw new Error('No AI API key configured');
  return createAnthropicClient(apiKey);
}

interface RawFacade {
  execute: (q: unknown) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}
async function rawAll<T>(client: unknown, query: unknown): Promise<T[]> {
  const c = client as RawFacade;
  const res = await c.execute(query);
  return res.rows as T[];
}

/**
 * Gather read-only grounding data from existing tables. No new capture —
 * derived at query time, same convention as the Library's gamification
 * signals.
 */
export async function gatherOrgGrounding(): Promise<OrgGrounding> {
  const db = await getTypedClient();

  const topSkillRows = await rawAll<{ skill_name: string }>(
    db,
    sql`SELECT skill_name, COUNT(*) as cnt FROM cowork_skill_invocations GROUP BY skill_name ORDER BY cnt DESC LIMIT ${TOP_SKILLS_LIMIT}`,
  );
  const topSkills = topSkillRows.map(r => r.skill_name);

  const systemServers = Array.from(SYSTEM_MCP_SERVERS);
  const connectorCounts = await rawAll<{ mcp_server: string; cnt: number | string }>(
    db,
    sql`SELECT mcp_server, COUNT(*) as cnt FROM cowork_mcp_invocations
         WHERE mcp_server NOT IN (${sql.join(systemServers.map(s => sql`${s}`), sql`, `)}) GROUP BY mcp_server ORDER BY cnt ASC`,
  );

  // "Underused" = below the mean invocation count for non-system connectors —
  // a fixed bottom-N by rank alone would misclassify a heavily-used connector
  // as underused whenever there are few distinct connectors overall.
  const counts = connectorCounts.map(r => ({ mcp_server: r.mcp_server, cnt: Number(r.cnt) }));
  const meanCount = counts.length > 0 ? counts.reduce((sum, r) => sum + r.cnt, 0) / counts.length : 0;
  const underusedConnectors = counts
    .filter(r => r.cnt < meanCount)
    .slice(0, UNDERUSED_CONNECTORS_LIMIT)
    .map(r => r.mcp_server);

  const topTaskTypeRows = await rawAll<{ task_type: string }>(
    db,
    sql`SELECT task_type, COUNT(*) as cnt FROM pulse_classifications GROUP BY task_type ORDER BY cnt DESC LIMIT ${TOP_TASK_TYPES_LIMIT}`,
  );
  const topTaskTypes = topTaskTypeRows.map(r => r.task_type);

  const codeWorkTypeRows = await rawAll<{ work_type: string }>(
    db,
    sql`SELECT work_type, COUNT(*) as cnt FROM code_session_classifications
         WHERE status = 'classified' GROUP BY work_type ORDER BY cnt DESC LIMIT ${CODE_WORK_TYPES_LIMIT}`,
  );
  const codeWorkTypes = codeWorkTypeRows.map(r => r.work_type);

  const u = schema.users;
  const deptRows = await db
    .selectDistinct({ department: u.department })
    .from(u)
    .where(and(isNotNull(u.department), ne(u.department, '')));
  const departments = deptRows.map(r => r.department as string);

  return { topSkills, underusedConnectors, topTaskTypes, codeWorkTypes, departments };
}

function listOrNone(items: string[]): string {
  return items.length > 0 ? items.join(', ') : '(none observed)';
}

function buildSystemPrompt(grounding: OrgGrounding, mode: IdeateMode): string {
  const opening = mode === 'scratch'
    ? `OPENING POSTURE ("from scratch"): Lead with sharp, open questions about the customer's goals, priorities, and pain points. Do NOT open with a data dump. You MAY reference the telemetry below to sharpen a question or ground a candidate, but let the customer's own thinking lead.`
    : `OPENING POSTURE ("from telemetry"): Open by analysing the telemetry below. Name the specific skills, connectors, task types, Code work types, or departments that stand out, and ask which the customer wants to pursue first.`;

  return `You are a brainstorm facilitator helping an organisation discover new AI use cases for Claude, grounded STRICTLY in their own observed usage and their own answers.

${opening}

The organisation's actual telemetry, gathered from their Frontier Command Centre instance:
- Most-used skills: ${listOrNone(grounding.topSkills)}
- Underused connectors (installed/available but rarely invoked): ${listOrNone(grounding.underusedConnectors)}
- Most common task types (from classified Cowork sessions): ${listOrNone(grounding.topTaskTypes)}
- Most common Code work types (from classified Code sessions): ${listOrNone(grounding.codeWorkTypes)}
- Departments active on the platform: ${listOrNone(grounding.departments)}

RULES:
1. Ground every question and every suggestion in the data above AND/OR the customer's own answers. When you reference the data, name the skills, connectors, task types, work types, or departments explicitly.
2. Do NOT invent industry-generic, "companies like yours", or benchmark/catalog suggestions. If the data above is sparse and the customer has not given you enough, ask a clarifying question instead of guessing generically.
3. Ask sharp, specific follow-up questions to sharpen ideas. Do not just list suggestions passively.
4. When you have enough signal, propose one or more candidate use cases as structured "candidates".

Respond with ONLY a valid JSON object (no markdown, no code fences, no explanation text outside the JSON) of this exact shape:
{
  "reply": "<your conversational reply and/or questions>",
  "candidates": [
    {
      "title": "<short plain-English name>",
      "description": "<1-3 sentences on what it is and why it matters>",
      "keywords": ["<optional distinctive keywords for later telemetry matching>"],
      "sourceExcerpt": "<optional verbatim quote from the conversation history that grounds this idea>"
    }
  ]
}

If you have no candidates to propose yet (e.g. you are still asking clarifying questions), return "candidates": [].`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function normaliseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const filtered = value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  return filtered.length > 0 ? filtered : undefined;
}

function toCandidate(item: unknown): IdeateCandidate | null {
  if (typeof item !== 'object' || item === null) return null;
  const obj = item as Record<string, unknown>;

  if (!isNonEmptyString(obj.title)) return null;
  if (!isNonEmptyString(obj.description)) return null;

  return {
    title: obj.title.trim(),
    description: obj.description.trim(),
    keywords: normaliseStringArray(obj.keywords),
    sourceExcerpt: isNonEmptyString(obj.sourceExcerpt) ? obj.sourceExcerpt.trim() : undefined,
  };
}

/**
 * Run one turn of the ideation chat via a single Claude call.
 * Never throws — malformed model output or a parse failure yields
 * { reply: <raw text>, candidates: [] }.
 */
export async function ideateTurn(history: ChatTurn[], mode: IdeateMode, grounding: OrgGrounding): Promise<IdeateTurnResult> {
  const model = (await getConfigValue('useCasesIdeateModel')) || 'claude-sonnet-5';
  const client = await getClient();

  const message = await queueAiCall(() =>
    client.messages.create({
      model,
      max_tokens: 2048,
      // No `temperature` — newer models (claude-sonnet-5, opus-4.x) reject it
      // with a 400; the field is configurable to any model via useCasesIdeateModel.
      system: buildSystemPrompt(grounding, mode),
      messages: history.map(turn => ({ role: turn.role, content: turn.content })),
    })
  );

  const rawText = extractText(message);
  const cleaned = stripCodeFences(rawText);

  const parsed = parseModelJson(cleaned);

  if (parsed === null || typeof parsed !== 'object') {
    return { reply: rawText, candidates: [] };
  }

  const obj = parsed as Record<string, unknown>;
  const reply = isNonEmptyString(obj.reply) ? obj.reply.trim() : rawText;

  const candidates: IdeateCandidate[] = [];
  if (Array.isArray(obj.candidates)) {
    for (const item of obj.candidates) {
      const candidate = toCandidate(item);
      if (candidate) candidates.push(candidate);
    }
  }

  return { reply, candidates };
}
