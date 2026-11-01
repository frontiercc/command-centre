// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// ChatGPT and Codex spend per conversation, for Spend Review.
//
// Codex: each turn's tokens, priced from the rates table, belong to its
// session: measured, as Claude Code's are.
//
// ChatGPT: OpenAI reports cost per person, per model, per hour, never per
// conversation. Each hour's cost (its tokens priced from the rates table, as
// FinOps prices them) is shared evenly across that person's replies on that
// model in that hour, and each share goes to the reply's conversation. With no
// reply on that model in the hour it is shared across the person's replies on
// any model; with no reply at all it stays with the person, unmatched, so
// their total still equals FinOps's. The shares are estimates: OpenAI does not
// say how big each reply was.
import { and, gte, lt, eq, inArray } from 'drizzle-orm';
import { schema } from '@/lib/db/schema';
import { priceTokens, type ModelRates, type TokenUsage } from '@/lib/pulse/code/rates';
import type { getTypedClient } from '@/lib/db/client';

type Client = Awaited<ReturnType<typeof getTypedClient>>;

export interface HourlyCost {
  userId: string;
  model: string | null;
  hourStart: number;
  usage: TokenUsage;
}

export interface Reply {
  userId: string;
  sessionId: string;
  model: string | null;
  occurredAt: number;
  /** When given, each reply's own share is returned in `byReply`. */
  id?: string;
}

/** One part of a conversation's ChatGPT cost: a share of one hour's cost on one model. */
export interface SessionShare {
  model: string | null;
  /** Null when the model has no rate. */
  usd: number | null;
  usage: TokenUsage;
  replies: number;
}

export interface SharedCosts {
  bySession: Map<string, { userId: string; parts: SessionShare[] }>;
  /** Each reply's share (replies given an id only). */
  byReply: Map<string, SessionShare[]>;
  /** Priced cost with no reply in its hour to share it across, per person. */
  unmatchedByUser: Map<string, number>;
  unpricedModels: Set<string>;
}

const HOUR = 3600;

function scale(u: TokenUsage, f: number): TokenUsage {
  return {
    inputTokens: u.inputTokens * f, outputTokens: u.outputTokens * f,
    cacheCreationTokens: u.cacheCreationTokens * f, cacheReadTokens: u.cacheReadTokens * f,
  };
}

/** Pure: share each hourly cost across the replies in its hour (see the header). */
export function shareHourlyCosts(costs: HourlyCost[], replies: Reply[], rates: ModelRates): SharedCosts {
  const byHourModel = new Map<string, Reply[]>();
  const byHour = new Map<string, Reply[]>();
  for (const r of replies) {
    const h = Math.floor(r.occurredAt / HOUR) * HOUR;
    const km = `${r.userId}|${h}|${r.model ?? ''}`;
    const kh = `${r.userId}|${h}`;
    (byHourModel.get(km) ?? byHourModel.set(km, []).get(km)!).push(r);
    (byHour.get(kh) ?? byHour.set(kh, []).get(kh)!).push(r);
  }
  const out: SharedCosts = { bySession: new Map(), byReply: new Map(), unmatchedByUser: new Map(), unpricedModels: new Set() };
  for (const c of costs) {
    const usd = c.model === null ? null : priceTokens(c.model, c.usage, rates);
    if (usd === null) out.unpricedModels.add(c.model ?? '(no model)');
    const matched = byHourModel.get(`${c.userId}|${c.hourStart}|${c.model ?? ''}`) ?? byHour.get(`${c.userId}|${c.hourStart}`);
    if (!matched || matched.length === 0) {
      if (usd !== null) out.unmatchedByUser.set(c.userId, (out.unmatchedByUser.get(c.userId) ?? 0) + usd);
      continue;
    }
    const perSession = new Map<string, number>();
    for (const r of matched) {
      perSession.set(r.sessionId, (perSession.get(r.sessionId) ?? 0) + 1);
      if (r.id) {
        const f = 1 / matched.length;
        const list = out.byReply.get(r.id) ?? [];
        out.byReply.set(r.id, list);
        list.push({ model: c.model, usd: usd === null ? null : usd * f, usage: scale(c.usage, f), replies: 1 });
      }
    }
    for (const [sessionId, n] of perSession) {
      const f = n / matched.length;
      const entry = out.bySession.get(sessionId) ?? { userId: c.userId, parts: [] };
      out.bySession.set(sessionId, entry);
      entry.parts.push({ model: c.model, usd: usd === null ? null : usd * f, usage: scale(c.usage, f), replies: n });
    }
  }
  return out;
}

export type OpenAiFilter = { all: true } | { userId: string } | { sessionIds: string[] };

const CHUNK = 1000;
async function inChunks<T, R>(ids: T[], fn: (part: T[]) => Promise<R[]>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...await fn(ids.slice(i, i + CHUNK)));
  return out;
}

/** ChatGPT cost per conversation over [start, end). A session filter is resolved to its people. */
export async function chatgptSessionShares(client: Client, rates: ModelRates, start: number, end: number, filter: OpenAiFilter): Promise<SharedCosts> {
  const oc = schema.openaiCosts;
  const or = schema.openaiReplies;
  let userIds: string[] | null = null;
  if ('userId' in filter) userIds = [filter.userId];
  if ('sessionIds' in filter) {
    if (filter.sessionIds.length === 0) return { bySession: new Map(), byReply: new Map(), unmatchedByUser: new Map(), unpricedModels: new Set() };
    const rows = await inChunks(filter.sessionIds, part => client.selectDistinct({ user_id: or.user_id }).from(or).where(inArray(or.session_id, part)));
    userIds = [...new Set(rows.map(r => r.user_id))];
    if (userIds.length === 0) return { bySession: new Map(), byReply: new Map(), unmatchedByUser: new Map(), unpricedModels: new Set() };
  }
  const costWhere = and(eq(oc.product, 'chatgpt'), gte(oc.hour_start, start), lt(oc.hour_start, end));
  const costSelect = {
    user_id: oc.user_id, model: oc.model, hour_start: oc.hour_start,
    inp: oc.input_tokens, cached: oc.cached_input_tokens, outp: oc.output_tokens,
  };
  const costRows = userIds === null
    ? await client.select(costSelect).from(oc).where(costWhere)
    : await inChunks(userIds, part => client.select(costSelect).from(oc).where(and(costWhere, inArray(oc.user_id, part))));
  const replyWhere = and(gte(or.occurred_at, start), lt(or.occurred_at, end));
  const replySelect = { user_id: or.user_id, session_id: or.session_id, model: or.model, occurred_at: or.occurred_at };
  const replyRows = userIds === null
    ? await client.select(replySelect).from(or).where(replyWhere)
    : await inChunks(userIds, part => client.select(replySelect).from(or).where(and(replyWhere, inArray(or.user_id, part))));

  const shared = shareHourlyCosts(
    costRows.filter(r => r.user_id).map(r => ({
      userId: r.user_id!, model: r.model, hourStart: Number(r.hour_start),
      usage: { inputTokens: Number(r.inp) || 0, outputTokens: Number(r.outp) || 0, cacheCreationTokens: 0, cacheReadTokens: Number(r.cached) || 0 },
    })),
    replyRows.map(r => ({ userId: r.user_id, sessionId: r.session_id, model: r.model, occurredAt: Number(r.occurred_at) })),
    rates,
  );
  if ('sessionIds' in filter) {
    const wanted = new Set(filter.sessionIds);
    for (const sid of [...shared.bySession.keys()]) if (!wanted.has(sid)) shared.bySession.delete(sid);
  }
  return shared;
}

export interface CodexSessionTurns {
  userId: string;
  parts: Array<{ model: string | null; usd: number | null; usage: TokenUsage; turns: number }>;
}

/** Codex cost per session over [start, end): each turn's tokens priced from the rates table. */
export async function codexSessionTurns(client: Client, rates: ModelRates, start: number, end: number, filter: OpenAiFilter): Promise<{ bySession: Map<string, CodexSessionTurns>; unpricedModels: Set<string> }> {
  const ct = schema.codexTurns;
  const select = {
    session_id: ct.session_id, user_id: ct.user_id, model: ct.model,
    inp: ct.uncached_input_tokens, cached: ct.cached_input_tokens, outp: ct.output_tokens, started_at: ct.started_at,
  };
  const where = and(gte(ct.started_at, start), lt(ct.started_at, end));
  const rows = 'all' in filter
    ? await client.select(select).from(ct).where(where)
    : 'userId' in filter
    ? await client.select(select).from(ct).where(and(where, eq(ct.user_id, filter.userId)))
    : await inChunks(filter.sessionIds, part => client.select(select).from(ct).where(and(where, inArray(ct.session_id, part))));
  const bySession = new Map<string, CodexSessionTurns>();
  const unpricedModels = new Set<string>();
  // Group per session and model first, so each model is priced once per session.
  const sums = new Map<string, { sessionId: string; userId: string; model: string | null; usage: TokenUsage; turns: number }>();
  for (const r of rows) {
    const key = `${r.session_id}|${r.model ?? ''}`;
    const s = sums.get(key) ?? { sessionId: r.session_id, userId: r.user_id, model: r.model, usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, turns: 0 };
    sums.set(key, s);
    s.usage.inputTokens += Number(r.inp) || 0;
    s.usage.outputTokens += Number(r.outp) || 0;
    s.usage.cacheReadTokens += Number(r.cached) || 0;
    s.turns += 1;
  }
  for (const s of sums.values()) {
    const usd = s.model === null ? null : priceTokens(s.model, s.usage, rates);
    if (usd === null) unpricedModels.add(s.model ?? '(no model)');
    const e = bySession.get(s.sessionId) ?? { userId: s.userId, parts: [] };
    bySession.set(s.sessionId, e);
    e.parts.push({ model: s.model, usd, usage: s.usage, turns: s.turns });
  }
  return { bySession, unpricedModels };
}

/**
 * One ChatGPT conversation's replies, each with its share of its hour's cost
 * (the Audit Log's where-the-money-went). The person's other replies in those
 * hours are read too, since they share the same hourly costs.
 */
export async function chatgptConversationReplies(client: Client, rates: ModelRates, sessionId: string): Promise<{
  userId: string | null;
  replies: Array<{ id: string; occurredAt: number; parts: SessionShare[] }>;
  unpricedModels: Set<string>;
}> {
  const or = schema.openaiReplies;
  const oc = schema.openaiCosts;
  const own = await client.select({ id: or.id, user_id: or.user_id, model: or.model, occurred_at: or.occurred_at }).from(or).where(eq(or.session_id, sessionId));
  if (own.length === 0) return { userId: null, replies: [], unpricedModels: new Set() };
  const userId = own[0].user_id;
  const hours = [...new Set(own.map(r => Math.floor(Number(r.occurred_at) / HOUR) * HOUR))];
  const costs = await client.select({ model: oc.model, hour_start: oc.hour_start, inp: oc.input_tokens, cached: oc.cached_input_tokens, outp: oc.output_tokens })
    .from(oc).where(and(eq(oc.product, 'chatgpt'), eq(oc.user_id, userId), inArray(oc.hour_start, hours)));
  const minH = Math.min(...hours);
  const maxH = Math.max(...hours) + HOUR;
  const theirs = await client.select({ id: or.id, session_id: or.session_id, model: or.model, occurred_at: or.occurred_at })
    .from(or).where(and(eq(or.user_id, userId), gte(or.occurred_at, minH), lt(or.occurred_at, maxH)));
  const shared = shareHourlyCosts(
    costs.map(c => ({
      userId, model: c.model, hourStart: Number(c.hour_start),
      usage: { inputTokens: Number(c.inp) || 0, outputTokens: Number(c.outp) || 0, cacheCreationTokens: 0, cacheReadTokens: Number(c.cached) || 0 },
    })),
    theirs.map(r => ({ id: r.id, userId, sessionId: r.session_id, model: r.model, occurredAt: Number(r.occurred_at) })),
    rates,
  );
  return {
    userId,
    replies: own.map(r => ({ id: r.id, occurredAt: Number(r.occurred_at), parts: shared.byReply.get(r.id) ?? [] })),
    unpricedModels: shared.unpricedModels,
  };
}
