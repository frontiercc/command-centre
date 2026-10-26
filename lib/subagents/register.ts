// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Claude subagents register (Admin → Claude subagents): every subagent seen in
 * the last 30 days on Claude Code and Cowork, who runs it, on which models and
 * at what cost. Measured from OTel, no model calls.
 *
 * Sources:
 *  - Claude Code: model calls in code_assistant_meta carrying agent_name,
 *    priced with the admin model rates (the same priceTokens as Developer Pulse).
 *  - Cowork: model calls in cowork_messages carrying agent_name (cost_usd as
 *    reported by the client), and subagent launches (tool rows named Agent or
 *    Task). Both are captured from migration 0036 onwards; a launch from before
 *    then has no name and counts only in the headline launch figure.
 */
import { sql } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import { getCodeModelRates, priceTokens } from '@/lib/pulse/code/rates';
import {
  classifySubagent,
  SUBAGENT_NEW_DAYS,
  SUBAGENT_WINDOW_DAYS,
  type SubagentPerson,
  type SubagentRegister,
  type SubagentRow,
  type SubagentSurface,
} from './shared';

type Row = Record<string, unknown>;

async function rows(query: ReturnType<typeof sql>): Promise<Row[]> {
  const client = await getTypedClient();
  const res = await client.execute(query);
  return (res as unknown as { rows: Row[] }).rows;
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Postgres returns array_agg as an array; guard against anything else. */
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []);

/** One fact: a subagent, a person, a model, on one surface. */
interface Fact {
  surface: SubagentSurface;
  name: string | null;
  querySource: string | null;
  userId: string | null;
  model: string | null;
  calls: number;
  launches: number;
  spendUsd: number | null;
  sessions: string[];
}

interface Acc {
  name: string;
  querySource: string | null;
  surfaces: Set<SubagentSurface>;
  modelSpend: Map<string, number | null>;
  users: Set<string>;
  sessions: Set<string>;
  calls: number;
  launches: number;
  spend: number;
  priced: boolean;
  byUser: Map<string, PersonAcc>;
}

interface PersonAcc {
  surfaces: Set<SubagentSurface>;
  sessions: Set<string>;
  calls: number;
  launches: number;
  spend: number;
  priced: boolean;
  models: Set<string>;
}

const addSpend = (current: number | null | undefined, add: number | null): number | null => {
  if (add === null) return current ?? null;
  return (current ?? 0) + add;
};

export async function buildSubagentRegister(nowS: number = Math.floor(Date.now() / 1000)): Promise<SubagentRegister> {
  const since = nowS - SUBAGENT_WINDOW_DAYS * 86400;
  const rates = await getCodeModelRates();
  const unpriced = new Set<string>();
  const facts: Fact[] = [];

  // Claude Code model calls inside subagents.
  for (const r of await rows(sql`
    SELECT agent_name, MAX(query_source) AS query_source, user_id, model,
           COUNT(*) AS calls,
           SUM(input_tokens) AS inp, SUM(output_tokens) AS outp,
           SUM(cache_creation_tokens) AS cw, SUM(cache_read_tokens) AS cr,
           array_agg(DISTINCT session_id) AS sessions
      FROM code_assistant_meta
     WHERE agent_name IS NOT NULL AND agent_name <> ''
       AND occurred_at >= ${since} AND model IS NOT NULL AND model <> ''
     GROUP BY agent_name, user_id, model`)) {
    const model = String(r.model);
    const usd = priceTokens(model, {
      inputTokens: num(r.inp), outputTokens: num(r.outp),
      cacheCreationTokens: num(r.cw), cacheReadTokens: num(r.cr),
    }, rates);
    if (usd === null) unpriced.add(model);
    facts.push({
      surface: 'code', name: String(r.agent_name), querySource: (r.query_source as string | null) ?? null,
      userId: (r.user_id as string | null) ?? null, model, calls: num(r.calls), launches: 0,
      spendUsd: usd, sessions: ids(r.sessions),
    });
  }

  // Cowork model calls inside subagents (cost as the client reports it).
  for (const r of await rows(sql`
    SELECT agent_name, MAX(query_source) AS query_source, user_id, model,
           COUNT(*) AS calls, SUM(cost_usd) AS cost, COUNT(cost_usd) AS costed,
           array_agg(DISTINCT session_id) AS sessions
      FROM cowork_messages
     WHERE message_type = 'cowork_api_request' AND surface = 'cowork'
       AND agent_name IS NOT NULL AND occurred_at >= ${since}
     GROUP BY agent_name, user_id, model`)) {
    facts.push({
      surface: 'cowork', name: String(r.agent_name), querySource: (r.query_source as string | null) ?? null,
      userId: (r.user_id as string | null) ?? null, model: (r.model as string | null) ?? null,
      calls: num(r.calls), launches: 0, spendUsd: num(r.costed) > 0 ? num(r.cost) : null, sessions: ids(r.sessions),
    });
  }

  // Cowork subagent launches; a launch from before capture has no name.
  for (const r of await rows(sql`
    SELECT agent_name, user_id, COUNT(*) AS launches, array_agg(DISTINCT session_id) AS sessions
      FROM cowork_messages
     WHERE message_type = 'cowork_tool_metadata' AND surface = 'cowork'
       AND content_preview IN ('Agent', 'Task') AND occurred_at >= ${since}
     GROUP BY agent_name, user_id`)) {
    facts.push({
      surface: 'cowork', name: (r.agent_name as string | null) ?? null, querySource: null,
      userId: (r.user_id as string | null) ?? null, model: null, calls: 0, launches: num(r.launches),
      spendUsd: null, sessions: ids(r.sessions),
    });
  }

  // Totals the shares are taken against.
  let codeTotal: number | null = null;
  for (const r of await rows(sql`
    SELECT model, SUM(input_tokens) AS inp, SUM(output_tokens) AS outp,
           SUM(cache_creation_tokens) AS cw, SUM(cache_read_tokens) AS cr
      FROM code_assistant_meta
     WHERE occurred_at >= ${since} AND model IS NOT NULL AND model <> ''
     GROUP BY model`)) {
    codeTotal = addSpend(codeTotal, priceTokens(String(r.model), {
      inputTokens: num(r.inp), outputTokens: num(r.outp),
      cacheCreationTokens: num(r.cw), cacheReadTokens: num(r.cr),
    }, rates));
  }
  const [coworkTotalRow] = await rows(sql`
    SELECT SUM(cost_usd) AS cost, COUNT(cost_usd) AS costed
      FROM cowork_messages
     WHERE message_type = 'cowork_api_request' AND surface = 'cowork' AND occurred_at >= ${since}`);
  const coworkTotal = coworkTotalRow && num(coworkTotalRow.costed) > 0 ? num(coworkTotalRow.cost) : null;

  // Aggregate named facts per subagent; an unnamed launch counts only in the headline.
  const byName = new Map<string, Acc>();
  let codeSubagentSpend: number | null = null;
  let coworkSubagentSpend: number | null = null;
  let coworkLaunches = 0;
  const coworkLaunchUsers = new Set<string>();

  for (const f of facts) {
    const userKey = f.userId ?? '';
    if (f.launches > 0) {
      coworkLaunches += f.launches;
      if (f.userId) coworkLaunchUsers.add(f.userId);
    }
    if (f.name === null) continue;
    if (f.calls > 0) {
      if (f.surface === 'code') codeSubagentSpend = addSpend(codeSubagentSpend, f.spendUsd);
      else coworkSubagentSpend = addSpend(coworkSubagentSpend, f.spendUsd);
    }
    const acc: Acc = byName.get(f.name) ?? {
      name: f.name, querySource: null, surfaces: new Set(), modelSpend: new Map(), users: new Set(),
      sessions: new Set(), calls: 0, launches: 0, spend: 0, priced: false, byUser: new Map(),
    };
    if (!acc.querySource && f.querySource) acc.querySource = f.querySource;
    acc.surfaces.add(f.surface);
    if (f.model) acc.modelSpend.set(f.model, addSpend(acc.modelSpend.get(f.model), f.spendUsd));
    if (f.userId) acc.users.add(f.userId);
    f.sessions.forEach(s => acc.sessions.add(s));
    acc.calls += f.calls;
    acc.launches += f.launches;
    if (f.spendUsd !== null) { acc.spend += f.spendUsd; acc.priced = true; }
    const pu: PersonAcc = acc.byUser.get(userKey) ?? {
      surfaces: new Set(), sessions: new Set(), calls: 0, launches: 0, spend: 0, priced: false, models: new Set(),
    };
    pu.surfaces.add(f.surface);
    f.sessions.forEach(s => pu.sessions.add(s));
    pu.calls += f.calls;
    pu.launches += f.launches;
    if (f.spendUsd !== null) { pu.spend += f.spendUsd; pu.priced = true; }
    if (f.model) pu.models.add(f.model);
    acc.byUser.set(userKey, pu);
    byName.set(f.name, acc);
  }

  // First and last seen over all stored history, both surfaces.
  const seen = new Map<string, { first: number; last: number }>();
  if (byName.size > 0) {
    for (const r of await rows(sql`
      SELECT agent_name, MIN(occurred_at) AS first_seen, MAX(occurred_at) AS last_seen FROM (
        SELECT agent_name, occurred_at FROM code_assistant_meta WHERE agent_name IS NOT NULL AND agent_name <> ''
        UNION ALL
        SELECT agent_name, occurred_at FROM cowork_messages WHERE agent_name IS NOT NULL AND surface = 'cowork'
      ) a GROUP BY agent_name`)) {
      seen.set(String(r.agent_name), { first: num(r.first_seen), last: num(r.last_seen) });
    }
  }

  // Names and departments, never the raw (hashed) telemetry id.
  const people = await personLabels([...byName.values()].flatMap(a => [...a.users]));
  const label = (userId: string) => people.get(userId) ?? { name: 'Unknown person', department: null };

  const newSince = nowS - SUBAGENT_NEW_DAYS * 86400;
  const out: SubagentRow[] = [...byName.values()].map(acc => {
    const cls = classifySubagent(acc.name, acc.querySource);
    const s = seen.get(acc.name) ?? { first: nowS, last: nowS };
    const byPerson: SubagentPerson[] = [...acc.byUser.entries()].map(([userId, pu]) => ({
      ...label(userId),
      surfaces: [...pu.surfaces].sort(),
      sessions: pu.sessions.size,
      calls: pu.calls,
      launches: pu.launches,
      spendUsd: pu.priced ? pu.spend : null,
      models: [...pu.models].sort(),
    })).sort((a, b) => (b.spendUsd ?? 0) - (a.spendUsd ?? 0) || b.sessions - a.sessions || a.name.localeCompare(b.name));
    return {
      name: acc.name,
      ...cls,
      surfaces: [...acc.surfaces].sort(),
      models: [...acc.modelSpend.entries()]
        .map(([model, spendUsd]) => ({ model, spendUsd }))
        .sort((a, b) => (b.spendUsd ?? -1) - (a.spendUsd ?? -1)),
      people: acc.users.size,
      sessions: acc.sessions.size,
      calls: acc.calls,
      launches: acc.launches,
      spendUsd: acc.priced ? acc.spend : null,
      firstSeen: s.first,
      lastSeen: s.last,
      isNew: cls.kind === 'custom' && s.first >= newSince,
      byPerson,
    };
  }).sort((a, b) =>
    Number(b.isNew) - Number(a.isNew)
    || (b.spendUsd ?? 0) - (a.spendUsd ?? 0)
    || b.sessions - a.sessions
    || a.name.localeCompare(b.name));

  return {
    windowDays: SUBAGENT_WINDOW_DAYS,
    newDays: SUBAGENT_NEW_DAYS,
    generatedAt: nowS,
    rows: out,
    totals: {
      subagents: out.length,
      custom: out.filter(r => r.kind === 'custom').length,
      builtIn: out.filter(r => r.kind === 'built_in').length,
      newCustom: out.filter(r => r.isNew).length,
      codeSubagentSpendUsd: codeSubagentSpend,
      codeTotalSpendUsd: codeTotal,
      coworkSubagentSpendUsd: coworkSubagentSpend,
      coworkTotalSpendUsd: coworkTotal,
      coworkLaunches,
      coworkLaunchPeople: coworkLaunchUsers.size,
    },
    unpricedModels: [...unpriced].sort(),
  };
}

/** Display name and department per telemetry user id (linked admin account first). */
async function personLabels(userIds: string[]): Promise<Map<string, { name: string; department: string | null }>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  const out = new Map<string, { name: string; department: string | null }>();
  if (unique.length === 0) return out;
  for (const r of await rows(sql`
    SELECT u.id,
           COALESCE(NULLIF(a.display_name, ''), NULLIF(u.display_name, ''), u.email) AS name,
           COALESCE(NULLIF(a.department, ''), NULLIF(u.department, '')) AS department
      FROM users u
      LEFT JOIN LATERAL (
        SELECT display_name, department FROM admin_users
         WHERE linked_cowork_user_id = u.id ORDER BY created_at LIMIT 1
      ) a ON true
     WHERE u.id IN (${sql.join(unique.map(id => sql`${id}`), sql`, `)})`)) {
    out.set(String(r.id), {
      name: (r.name as string | null) || 'Unknown person',
      department: (r.department as string | null) ?? null,
    });
  }
  return out;
}
