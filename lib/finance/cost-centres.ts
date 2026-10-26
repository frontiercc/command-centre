// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Cost-centre resolution for chargeback. A department mapped in
 * `chargeback_dept_map` rolls up under its cost centre (name + optional GL
 * code); several departments may point at ONE centre (grouping). A department
 * with no mapping is its own implicit centre — so the feature works with zero
 * mapping rows on day one.
 *
 * Follows the pattern in lib/db/queries.ts / lib/pulse/code/dept.ts:
 * getTypedClient() + a local rawAll() facade for the JOIN below.
 * All read columns here are TEXT (department/name/code) — no numeric/bigint
 * coercion is needed.
 */
import { sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';

export interface ResolvedCentre { name: string; code: string | null; }

// ─── Phase 3 raw-execution facade (mirrors lib/db/queries.ts's rawAll) ────────
interface RawFacade {
  execute: (q: unknown) => Promise<{ rows: unknown[]; rowCount: number | null }>;
}
async function rawAll<T>(client: unknown, query: unknown): Promise<T[]> {
  const c = client as RawFacade;
  const res = await c.execute(query);
  return res.rows as T[];
}

/** department (verbatim) -> its mapped cost centre. Unmapped depts are absent. */
export async function resolveDeptToCentre(): Promise<Map<string, ResolvedCentre>> {
  const db = await getTypedClient();
  const rows = await rawAll<{ department: string; name: string; code: string | null }>(
    db,
    sql`
     SELECT m.department AS department, c.name AS name, c.code AS code
     FROM chargeback_dept_map m
     JOIN chargeback_cost_centres c ON c.id = m.cost_centre_id`
  );
  const map = new Map<string, ResolvedCentre>();
  for (const r of rows) map.set(r.department, { name: r.name, code: r.code });
  return map;
}
