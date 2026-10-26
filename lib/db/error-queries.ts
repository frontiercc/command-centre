// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Reference conversion: async Drizzle on Postgres.
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { getTypedClient } from './client';
import { schema } from './schema';
import { withTx } from './with-tx';

// ─── Types ──────────────────────────────────────────────────────────────

export interface ErrorEvent {
  id: number;
  occurred_at: number;
  severity: 'crash' | 'error' | 'warning' | 'info';
  source: string;
  message: string;
  stack_trace: string | null;
  context_json: string | null;
}

export interface InsertErrorEvent {
  severity: 'crash' | 'error' | 'warning' | 'info';
  source: string;
  message: string;
  stack_trace?: string | null;
  context_json?: string | null;
}

export interface ErrorQueryFilters {
  severity?: string;
  source?: string;
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
}

// ─── Queries ────────────────────────────────────────────────────────────

export async function insertErrorEvents(events: InsertErrorEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const client = await getTypedClient();

  // occurred_at comes from the app clock (seconds since epoch), not an
  // INSERT-time database default.
  const nowS = Math.floor(Date.now() / 1000);
  const rows = events.map((e) => ({
    occurred_at: nowS,
    severity: e.severity,
    source: e.source,
    message: e.message,
    stack_trace: e.stack_trace ?? null,
    context_json: e.context_json ?? null,
  }));

  // A transaction that RETURNS a value, run via `withTx`.
  return withTx(client, async (tx) => {
    await tx.insert(schema.errorEvents).values(rows);
    return rows.length;
  });
}

export async function queryErrorEvents(
  filters: ErrorQueryFilters = {},
): Promise<{ events: ErrorEvent[]; total: number }> {
  const db = await getTypedClient();
  const t = schema.errorEvents;

  const conditions = [];
  if (filters.severity) conditions.push(eq(t.severity, filters.severity));
  if (filters.source) conditions.push(eq(t.source, filters.source));
  if (filters.from) conditions.push(gte(t.occurred_at, filters.from));
  if (filters.to) conditions.push(lte(t.occurred_at, filters.to));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const limit = Math.min(filters.limit ?? 100, 500);
  const offset = filters.offset ?? 0;

  const totalRows = await db
    .select({ count: sql<number>`count(*)` })
    .from(t)
    .where(where);
  const total = Number(totalRows[0]?.count ?? 0);

  const events = (await db
    .select()
    .from(t)
    .where(where)
    .orderBy(desc(t.occurred_at))
    .limit(limit)
    .offset(offset)) as ErrorEvent[];

  return { events, total };
}
