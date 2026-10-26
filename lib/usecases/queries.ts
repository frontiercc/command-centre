// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Use Cases register (Phase 1) — data layer for the `use_cases` table
 * (migration 056). Capture + activate only; no tracking tables here.
 *
 * Async Drizzle on Postgres (blessed pattern: see lib/db/error-queries.ts /
 * lib/db/queries.ts) via getTypedClient(). listUseCases tiebreaks on `id DESC`
 * (use_cases.id is a text/uuid PK — a stable, deterministic tiebreak);
 * timestamps come from the app clock (matches error-queries.ts).
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

export type UseCaseOrigin = 'planned' | 'emergent' | 'ideated';
export type UseCaseStatus = 'candidate' | 'confirmed' | 'archived';
export type UseCaseLifecycle = 'not_seen' | 'piloting' | 'adopted' | 'at_risk';
export type UseCaseCaptureMethod = 'guided' | 'ideation' | 'transcript' | 'suggested' | 'process_mined';

export interface UseCase {
  id: string;
  title: string;
  description: string | null;
  ownerUserId: string | null;
  departments: string[];
  surfaces: string[];
  keywords: string[];
  skills: string[];
  connectors: string[];
  taskTypes: string[];
  origin: UseCaseOrigin;
  status: UseCaseStatus;
  lifecycle: UseCaseLifecycle;
  lifecycleChangedAt: number | null;
  strategic: number;
  captureMethod: UseCaseCaptureMethod;
  sourceExcerpt: string | null;
  createdBy: string | null;
  activateResult: unknown | null;
  lastActivatedAt: number | null;
  impactSummary: string | null;
  impactSummaryAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** Department Process Transformation (migration 077/0018) — human-entered
   *  at confirm time, display only; never matched/derived. */
  painPoint: string | null;
  valueHypothesis: string | null;
  baselineNote: string | null;
  kpiNote: string | null;
}

interface UseCaseRow {
  id: string;
  title: string;
  description: string | null;
  owner_user_id: string | null;
  departments: string | null;
  surfaces: string | null;
  keywords: string | null;
  skills: string | null;
  connectors: string | null;
  task_types: string | null;
  origin: string;
  status: string;
  lifecycle: string;
  lifecycle_changed_at: number | null;
  strategic: number;
  capture_method: string;
  source_excerpt: string | null;
  created_by: string | null;
  activate_result: string | null;
  last_activated_at: number | null;
  impact_summary: string | null;
  impact_summary_at: number | null;
  created_at: number;
  updated_at: number;
  pain_point: string | null;
  value_hypothesis: string | null;
  baseline_note: string | null;
  kpi_note: string | null;
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonValue(raw: string | null): unknown | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function rowToUseCase(row: UseCaseRow): UseCase {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    ownerUserId: row.owner_user_id,
    departments: parseJsonArray(row.departments),
    surfaces: parseJsonArray(row.surfaces),
    keywords: parseJsonArray(row.keywords),
    skills: parseJsonArray(row.skills),
    connectors: parseJsonArray(row.connectors),
    taskTypes: parseJsonArray(row.task_types),
    origin: row.origin as UseCaseOrigin,
    status: row.status as UseCaseStatus,
    lifecycle: row.lifecycle as UseCaseLifecycle,
    lifecycleChangedAt: row.lifecycle_changed_at,
    strategic: row.strategic,
    captureMethod: row.capture_method as UseCaseCaptureMethod,
    sourceExcerpt: row.source_excerpt,
    createdBy: row.created_by,
    activateResult: parseJsonValue(row.activate_result),
    lastActivatedAt: row.last_activated_at,
    impactSummary: row.impact_summary,
    impactSummaryAt: row.impact_summary_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    painPoint: row.pain_point,
    valueHypothesis: row.value_hypothesis,
    baselineNote: row.baseline_note,
    kpiNote: row.kpi_note,
  };
}

/** Affected-row count from node-postgres's `rowCount`. */
function rowsAffected(result: unknown): number {
  return (result as { rowCount?: number | null }).rowCount ?? 0;
}

export async function createUseCase(input: Partial<UseCase> & { title: string; createdBy?: string }): Promise<UseCase> {
  const client = await getTypedClient();
  const t = schema.useCases;
  const id = randomUUID();

  await client.insert(t).values({
    id,
    title: input.title,
    description: input.description ?? null,
    owner_user_id: input.ownerUserId ?? null,
    departments: JSON.stringify(input.departments ?? []),
    surfaces: JSON.stringify(input.surfaces ?? []),
    keywords: JSON.stringify(input.keywords ?? []),
    skills: JSON.stringify(input.skills ?? []),
    connectors: JSON.stringify(input.connectors ?? []),
    task_types: JSON.stringify(input.taskTypes ?? []),
    origin: input.origin ?? 'planned',
    status: input.status ?? 'candidate',
    capture_method: input.captureMethod ?? 'guided',
    source_excerpt: input.sourceExcerpt ?? null,
    created_by: input.createdBy ?? null,
    activate_result: input.activateResult != null ? JSON.stringify(input.activateResult) : null,
    last_activated_at: input.lastActivatedAt ?? null,
    pain_point: input.painPoint ?? null,
    value_hypothesis: input.valueHypothesis ?? null,
    baseline_note: input.baselineNote ?? null,
    kpi_note: input.kpiNote ?? null,
  });

  return (await getUseCase(id))!;
}

export async function listUseCases(filter?: { status?: string; origin?: string }): Promise<UseCase[]> {
  const client = await getTypedClient();
  const t = schema.useCases;

  const conditions = [];
  if (filter?.status) conditions.push(eq(t.status, filter.status));
  if (filter?.origin) conditions.push(eq(t.origin, filter.origin));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // Tiebreak: `id` (text/uuid PK) DESC — stable and deterministic (Postgres
  // has no rowid).
  const rows = (await client
    .select()
    .from(t)
    .where(where)
    .orderBy(desc(t.created_at), desc(t.id))) as UseCaseRow[];

  return rows.map(rowToUseCase);
}

export async function getUseCase(id: string): Promise<UseCase | undefined> {
  const client = await getTypedClient();
  const t = schema.useCases;
  const rows = (await client.select().from(t).where(eq(t.id, id)).limit(1)) as UseCaseRow[];
  return rows[0] ? rowToUseCase(rows[0]) : undefined;
}

const JSON_ARRAY_FIELDS: Array<keyof UseCase> = ['departments', 'surfaces', 'keywords', 'skills', 'connectors', 'taskTypes'];

const FIELD_TO_COLUMN: Record<string, string> = {
  title: 'title',
  description: 'description',
  ownerUserId: 'owner_user_id',
  departments: 'departments',
  surfaces: 'surfaces',
  keywords: 'keywords',
  skills: 'skills',
  connectors: 'connectors',
  taskTypes: 'task_types',
  origin: 'origin',
  status: 'status',
  lifecycle: 'lifecycle',
  lifecycleChangedAt: 'lifecycle_changed_at',
  strategic: 'strategic',
  captureMethod: 'capture_method',
  sourceExcerpt: 'source_excerpt',
  createdBy: 'created_by',
  activateResult: 'activate_result',
  lastActivatedAt: 'last_activated_at',
  painPoint: 'pain_point',
  valueHypothesis: 'value_hypothesis',
  baselineNote: 'baseline_note',
  kpiNote: 'kpi_note',
};

export async function updateUseCase(id: string, patch: Partial<UseCase>): Promise<UseCase | undefined> {
  const client = await getTypedClient();
  const t = schema.useCases;
  const existing = await getUseCase(id);
  if (!existing) return undefined;

  // Built dynamically from an allowlisted field->column map — genuinely
  // variable shape per call, so a narrow local cast (not a file-wide `as any`)
  // is used at the .set() call below, mirroring the "reach for a narrow local
  // cast only where genuinely needed" guidance for typed builders.
  const set: Record<string, unknown> = {};

  for (const [field, column] of Object.entries(FIELD_TO_COLUMN)) {
    if (!(field in patch)) continue;
    const value = (patch as Record<string, unknown>)[field];

    if (JSON_ARRAY_FIELDS.includes(field as keyof UseCase)) {
      set[column] = JSON.stringify(value ?? []);
    } else if (field === 'activateResult') {
      set[column] = value != null ? JSON.stringify(value) : null;
    } else {
      set[column] = value ?? null;
    }
  }

  // App clock.
  const nowS = Math.floor(Date.now() / 1000);
  set.updated_at = nowS;

  await client.update(t).set(set as never).where(eq(t.id, id));

  return getUseCase(id);
}

export async function deleteUseCase(id: string): Promise<boolean> {
  const client = await getTypedClient();
  const t = schema.useCases;
  const result = await client.delete(t).where(eq(t.id, id));
  return rowsAffected(result) > 0;
}
