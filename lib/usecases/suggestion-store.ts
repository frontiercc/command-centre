// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Async Drizzle on Postgres. Lists order by `generated_at DESC, id DESC`
 * (use_case_suggestions.id is a text/uuid PK — Postgres has no rowid). The
 * conditional "never reopen a dismissed/added row" upsert uses Drizzle's
 * `setWhere` (a WHERE clause on the DO UPDATE, referencing the pre-conflict
 * row via the target table).
 */
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { groupDeptBoxes, type DeptBox, type SuggestionSurface } from '@/lib/usecases/dept-boxes';

export interface SignalSet { skills: string[]; connectors: string[]; taskTypes: string[] }
export interface SuggestionEvidence { distinctUsers: number; sessionCount: number; departments: string[] }
export interface SuggestionDraft {
  id: string; signalKey: string; title: string; description: string | null;
  matchingRule: SignalSet & { departments: string[]; keywords?: string[] };
  evidence: SuggestionEvidence; status: 'open' | 'dismissed' | 'added'; generatedAt: number;
  department: string | null; canvas: ProcessCanvas | null;
  /** Where a mined suggestion was found; null on older rows, all from Cowork. */
  surface: SuggestionSurface | null;
}

/** Department Process Transformation (migration 077/0018) — a content-first
 *  draft canvas attached to a dept-scoped suggestion row. A
 *  cross-department suggestion is department === null WITH a canvas (and
 *  `departments` set); the retired tool-combination tray's rows are
 *  department === null with no canvas, and are never shown. */
export interface ProcessCanvas {
  story: string; valueHypothesis: string;
  /** The departments the cited prompts came from (cross-department suggestions only). */
  departments?: string[];
  people: number; sessions: number; occasions: number; windowDays: number;
  rhythm: { label: 'monthly' | 'weekly' | 'recurring'; display: string };
  systems: string[]; activeHours: number | null; tierNote: string | null;
}

/** One box of open department suggestions per department, from listOpenDeptBoxes(), with
 *  its Cowork and Claude Code lists (see lib/usecases/dept-boxes.ts). */
export type DeptProcessBox = DeptBox<SuggestionDraft>;

export function computeSignalKey(s: SignalSet): string {
  const norm = (arr: string[]) => [...arr].map(v => v.toLowerCase()).sort();
  const canonical = JSON.stringify({ skills: norm(s.skills), connectors: norm(s.connectors), taskTypes: norm(s.taskTypes) });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

interface Row {
  id: string; signal_key: string; title: string; description: string | null; matching_rule: string;
  evidence: string; status: string; generated_at: number;
  department: string | null; canvas_json: string | null;
  surface: string | null; cited_sessions: string | null;
}
function parseCanvas(raw: string | null): ProcessCanvas | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ProcessCanvas;
  } catch {
    return null;
  }
}
function toDraft(r: Row): SuggestionDraft {
  return {
    id: r.id, signalKey: r.signal_key, title: r.title, description: r.description,
    matchingRule: JSON.parse(r.matching_rule), evidence: JSON.parse(r.evidence),
    status: r.status as SuggestionDraft['status'], generatedAt: r.generated_at,
    department: r.department, canvas: parseCanvas(r.canvas_json),
    surface: r.surface === 'code' ? 'code' : r.surface === 'cowork' ? 'cowork' : null,
  };
}

export async function upsertOpenSuggestion(input: {
  signalKey: string; title: string; description: string | null;
  matchingRule: SignalSet & { departments: string[]; keywords?: string[] }; evidence: SuggestionEvidence; nowS: number;
  department?: string; canvas?: ProcessCanvas;
  /** Where it was found. */
  surface?: SuggestionSurface;
  /** The sessions it was based on, so a dismissed one is not suggested again reworded. */
  citedSessions?: string[];
}): Promise<void> {
  const client = await getTypedClient();
  const t = schema.useCaseSuggestions;

  await client
    .insert(t)
    .values({
      id: randomUUID(),
      signal_key: input.signalKey,
      title: input.title,
      description: input.description,
      matching_rule: JSON.stringify(input.matchingRule),
      evidence: JSON.stringify(input.evidence),
      status: 'open',
      generated_at: input.nowS,
      updated_at: input.nowS,
      department: input.department ?? null,
      canvas_json: input.canvas ? JSON.stringify(input.canvas) : null,
      surface: input.surface ?? null,
      cited_sessions: input.citedSessions ? JSON.stringify(input.citedSessions) : null,
    })
    .onConflictDoUpdate({
      target: t.signal_key,
      set: {
        title: sql`excluded.title`,
        description: sql`excluded.description`,
        matching_rule: sql`excluded.matching_rule`,
        evidence: sql`excluded.evidence`,
        generated_at: sql`excluded.generated_at`,
        updated_at: sql`excluded.updated_at`,
        department: sql`excluded.department`,
        canvas_json: sql`excluded.canvas_json`,
        surface: sql`excluded.surface`,
        cited_sessions: sql`excluded.cited_sessions`,
      },
      // Never reopen a dismissed/added row — only refresh a row that's still open.
      setWhere: sql`${t.status} = 'open'`,
    });
}

export async function listOpenSuggestions(): Promise<SuggestionDraft[]> {
  const client = await getTypedClient();
  const t = schema.useCaseSuggestions;
  const rows = (await client
    .select()
    .from(t)
    .where(eq(t.status, 'open'))
    .orderBy(desc(t.generated_at), desc(t.id))) as Row[];
  return rows.map(toDraft);
}

export async function getSuggestionById(id: string): Promise<SuggestionDraft | undefined> {
  const client = await getTypedClient();
  const t = schema.useCaseSuggestions;
  const rows = (await client.select().from(t).where(eq(t.id, id)).limit(1)) as Row[];
  return rows[0] ? toDraft(rows[0]) : undefined;
}

export async function setSuggestionStatus(id: string, status: 'open' | 'dismissed' | 'added'): Promise<void> {
  const client = await getTypedClient();
  const t = schema.useCaseSuggestions;
  const nowS = Math.floor(Date.now() / 1000); // app clock
  await client.update(t).set({ status, updated_at: nowS }).where(eq(t.id, id));
}

export async function getSuggestionBySignalKey(signalKey: string): Promise<SuggestionDraft | undefined> {
  const client = await getTypedClient();
  const t = schema.useCaseSuggestions;
  const rows = (await client.select().from(t).where(eq(t.signal_key, signalKey)).limit(1)) as Row[];
  return rows[0] ? toDraft(rows[0]) : undefined;
}

export async function resolvedSignalKeys(): Promise<Set<string>> {
  const client = await getTypedClient();
  const t = schema.useCaseSuggestions;
  const rows = await client.select({ signal_key: t.signal_key }).from(t).where(inArray(t.status, ['dismissed', 'added']));
  return new Set(rows.map(r => r.signal_key));
}

/** The sessions behind every suggestion a person dismissed or added (older rows
 *  stored none). A new suggestion built mostly on one of these is not suggested again. */
export async function resolvedSessionSets(): Promise<string[][]> {
  const client = await getTypedClient();
  const t = schema.useCaseSuggestions;
  const rows = await client.select({ cited: t.cited_sessions }).from(t)
    .where(and(inArray(t.status, ['dismissed', 'added']), isNotNull(t.cited_sessions)));
  const out: string[][] = [];
  for (const r of rows) {
    try {
      const v = JSON.parse(r.cited ?? '[]') as unknown;
      if (Array.isArray(v)) out.push(v.filter((x): x is string => typeof x === 'string'));
    } catch { /* an unreadable row cannot block anything */ }
  }
  return out;
}

export async function countOpenByDepartment(department: string): Promise<number> {
  const client = await getTypedClient();
  const t = schema.useCaseSuggestions;
  const rows = await client.select({ id: t.id }).from(t).where(and(eq(t.status, 'open'), eq(t.department, department)));
  return rows.length;
}

/** Open cross-department suggestions (department NULL, with a canvas). */
export async function countOpenAcrossDepartments(): Promise<number> {
  const client = await getTypedClient();
  const t = schema.useCaseSuggestions;
  const rows = await client.select({ id: t.id }).from(t)
    .where(and(eq(t.status, 'open'), isNull(t.department), isNotNull(t.canvas_json)));
  return rows.length;
}

/** Every cross-department suggestion title ever proposed, across all statuses
 *  (department NULL with a canvas). */
export async function listAcrossSuggestionTitles(): Promise<string[]> {
  const client = await getTypedClient();
  const t = schema.useCaseSuggestions;
  const rows = await client.select({ title: t.title }).from(t).where(and(isNull(t.department), isNotNull(t.canvas_json)));
  return rows.map(r => r.title);
}

/** Department suggestion titles a person has dismissed or confirmed: the
 *  cross-department pass must not bring them back under a new key.
 *  Still-open department titles are not included, because the
 *  shared work should be claimed across departments. */
export async function listResolvedDepartmentTitles(): Promise<string[]> {
  const client = await getTypedClient();
  const t = schema.useCaseSuggestions;
  const rows = await client.select({ title: t.title }).from(t)
    .where(and(isNotNull(t.department), isNotNull(t.canvas_json), inArray(t.status, ['dismissed', 'added'])));
  return rows.map(r => r.title);
}

/** Every suggestion title ever proposed for a department, across ALL
 *  statuses (open/dismissed/added) — feeds the mining prompt's prior-titles
 *  dedup block so the model is told not to re-propose,
 *  even reworded, a process this department has already seen. */
export async function listSuggestionTitlesByDepartment(department: string): Promise<string[]> {
  const client = await getTypedClient();
  const t = schema.useCaseSuggestions;
  const rows = await client.select({ title: t.title }).from(t).where(eq(t.department, department));
  return rows.map(r => r.title);
}

/** Open department suggestions, one box per department, alphabetical; Cowork and Claude Code
 *  suggestions are separate lists inside it, each ranked by people then sessions. */
export async function listOpenDeptBoxes(): Promise<DeptProcessBox[]> {
  return groupDeptBoxes(await listOpenSuggestions());
}
