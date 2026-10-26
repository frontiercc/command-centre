// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Deterministic Use Cases section for the governance report.
//
// Deliberately narrow: the registered use cases and whether each was seen in
// telemetry. Lifecycle, owners, strategic bets and value estimates all live on
// the governance page; a report section that restated them would duplicate that
// surface without adding anything a reader can act on.
//
// `lifecycle` is tracker-owned and derived from measured weekly activity;
// 'not_seen' means the tracker found no matching telemetry, which is a
// measured absence rather than a judgement.
import { desc, ne } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';

export interface UseCaseRow {
  title: string;
  lifecycle: string;
  lastActivatedAt: number | null;
}

export interface UseCasesFacts {
  hasData: boolean;
  rows: UseCaseRow[];
}

/** 'piloting' | 'adopted' | 'at_risk' all mean the use case was observed. */
export function isLive(lifecycle: string): boolean {
  return lifecycle !== 'not_seen';
}

function statusLabel(lifecycle: string): string {
  return isLive(lifecycle) ? 'Live' : 'Not seen';
}

export function renderUseCasesSection(f: UseCasesFacts): string {
  if (!f.hasData || f.rows.length === 0) {
    return `## Use Cases

No use cases have been registered, so there is nothing to match against telemetry.`;
  }

  const live = f.rows.filter(r => isLive(r.lifecycle)).length;
  const notSeen = f.rows.length - live;

  const table = f.rows
    .map(r => `| ${r.title} | ${statusLabel(r.lifecycle)} | ${r.lifecycle} |`)
    .join('\n');

  return `## Use Cases

${live} of ${f.rows.length} registered use case${f.rows.length === 1 ? '' : 's'} ${live === 1 ? 'was' : 'were'} found in telemetry; ${notSeen} ${notSeen === 1 ? 'was' : 'were'} not seen.

| Use case | Found | Lifecycle |
|---|---|---|
${table}

"Not seen" means the tracker found no matching activity. That is a measured absence, not a judgement about whether the use case is worthwhile.`;
}

export async function buildUseCasesSection(): Promise<string> {
  const db = await getTypedClient();
  const uc = schema.useCases;

  const rows = await db
    .select({ title: uc.title, lifecycle: uc.lifecycle, lastActivatedAt: uc.last_activated_at })
    .from(uc)
    .where(ne(uc.status, 'archived'))
    .orderBy(desc(uc.updated_at))
    .limit(100);

  return renderUseCasesSection({
    hasData: rows.length > 0,
    rows: rows.map(r => ({
      title: r.title,
      lifecycle: r.lifecycle,
      lastActivatedAt: r.lastActivatedAt ?? null,
    })),
  });
}
