// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Ask the data's question log: the question, the lookups that ran, the outcome and the
 * measured cost. The answer text is never stored. Rows older than the admin's retention
 * setting are deleted each time a question is logged.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, gte, lt, sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { getCodeModelRates, priceTokens } from '@/lib/pulse/code/rates';
import type { AskUsage } from '@/lib/ask/run';

export type LoggedOutcome = 'answered' | 'not_answerable' | 'refused' | 'capped' | 'error';

/** Start of the current calendar month (UTC), in seconds. */
export function monthStart(nowS: number): number {
  const d = new Date(nowS * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
}

/** List-price cost of one question's tokens, or null when the model has no price. */
export async function costOf(model: string, u: AskUsage): Promise<number | null> {
  const rates = await getCodeModelRates();
  return priceTokens(model, { inputTokens: u.input, outputTokens: u.output, cacheCreationTokens: u.cacheWrite, cacheReadTokens: u.cacheRead }, rates);
}

/** Measured spend on Ask the data since the start of this month (USD). */
export async function spendThisMonth(nowS: number): Promise<number> {
  const db = await getTypedClient();
  const l = schema.askLog;
  const rows = await db.select({ usd: sql<string>`COALESCE(SUM(${l.cost_usd}), 0)` }).from(l).where(gte(l.asked_at, monthStart(nowS)));
  return Number(rows[0]?.usd ?? 0);
}

export async function logQuestion(row: {
  askedBy: string; question: string; page: string | null; lookups: unknown[]; outcome: LoggedOutcome;
  model: string; usage: AskUsage; costUsd: number | null; durationMs: number; nowS: number; retentionDays: number;
}): Promise<void> {
  const db = await getTypedClient();
  const l = schema.askLog;
  await db.insert(l).values({
    id: randomUUID(),
    asked_at: row.nowS,
    asked_by: row.askedBy,
    question: row.question,
    page: row.page,
    lookups_json: JSON.stringify(row.lookups),
    outcome: row.outcome,
    model: row.model,
    input_tokens: row.usage.input,
    output_tokens: row.usage.output,
    cache_read_tokens: row.usage.cacheRead,
    cache_write_tokens: row.usage.cacheWrite,
    cost_usd: row.costUsd === null ? null : String(row.costUsd),
    duration_ms: row.durationMs,
  });
  if (row.retentionDays > 0) await db.delete(l).where(lt(l.asked_at, row.nowS - row.retentionDays * 86400));
}

export interface LogRow {
  askedAt: number; askedBy: string; question: string; page: string | null; lookups: string[];
  outcome: string; costUsd: number | null; durationMs: number | null;
}

/** The latest questions, newest first. */
export async function recentQuestions(limit: number, sinceS = 0): Promise<LogRow[]> {
  const db = await getTypedClient();
  const l = schema.askLog;
  const rows = await db.select().from(l).where(and(gte(l.asked_at, sinceS))).orderBy(desc(l.asked_at)).limit(limit);
  return rows.map(r => {
    let names: string[] = [];
    try { names = (JSON.parse(r.lookups_json) as Array<{ name?: unknown }>).map(x => String(x.name)); } catch { names = []; }
    return {
      askedAt: Number(r.asked_at), askedBy: r.asked_by, question: r.question, page: r.page, lookups: names,
      outcome: r.outcome, costUsd: r.cost_usd === null ? null : Number(r.cost_usd), durationMs: r.duration_ms,
    };
  });
}

/** This month's questions by outcome. */
export async function outcomesThisMonth(nowS: number): Promise<Record<string, number>> {
  const db = await getTypedClient();
  const l = schema.askLog;
  const rows = await db.select({ outcome: l.outcome, n: sql<string>`COUNT(*)` }).from(l).where(gte(l.asked_at, monthStart(nowS))).groupBy(l.outcome);
  return Object.fromEntries(rows.map(r => [r.outcome, Number(r.n)]));
}
