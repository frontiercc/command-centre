// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Ask the data: the lookups the model may call. Each one calls the API route behind a page, in
 * process and with the asking admin's own session, so an answer uses exactly the figures that
 * page shows, under the same access rules, and every read is in the access log as usual.
 * The model never reads the database. Two lookups do arithmetic in code (calculate) or end the
 * question (cannot_answer); everything else is a page's data.
 */
import { NextRequest } from 'next/server';
import type Anthropic from '@anthropic-ai/sdk';
import { inArray } from 'drizzle-orm';
import { pickCompact, compact } from '@/lib/ask/compact';
import { getTypedClient } from '@/lib/db/client';
import { schema } from '@/lib/db/schema';
import { isOpenAiSource, OPENAI_SOURCE_LABELS } from '@/lib/openai/sources';

type Vendor = 'all' | 'claude' | 'openai';

export interface LookupResult {
  /** What the model reads: compacted JSON. */
  data: unknown;
  /** The page these figures are on, for the answer's links. Null for calculate. */
  page: { label: string; href: string } | null;
}

export interface LookupContext {
  /** The asking request: its cookies carry the admin's session into every page route. */
  request: NextRequest;
}

type Handler = (req: NextRequest, ctx?: unknown) => Promise<Response>;

/** Call a page route's GET in process with the asking admin's session. */
async function callRoute(ctx: LookupContext, path: string, params: Record<string, string | undefined>, handler: Handler, routeCtx?: unknown): Promise<{ ok: true; body: unknown } | { ok: false; status: number }> {
  const url = new URL(path, ctx.request.nextUrl.origin);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, v);
  const req = new NextRequest(url, { headers: ctx.request.headers });
  const res = await handler(req, routeCtx);
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, body: await res.json() };
}

function unavailable(status: number, what: string): LookupResult {
  const why = status === 404 ? `${what} is turned off in Admin, so there is nothing to look up.`
    : status === 403 ? `${what} is not available to this account.`
    : `${what} could not be read (status ${status}).`;
  return { data: { unavailable: why }, page: null };
}

// ─── Input helpers ───────────────────────────────────────────────────────────

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
function vendorOf(input: Record<string, unknown>): Vendor {
  const v = str(input, 'vendor');
  return v === 'claude' || v === 'openai' ? v : 'all';
}
function periodOf(input: Record<string, unknown>): string | undefined {
  const p = str(input, 'period');
  return p && /^\d{4}-\d{2}$/.test(p) ? p : undefined;
}

const VENDOR_PROP = { type: 'string', enum: ['all', 'claude', 'openai'], description: 'all = Claude and OpenAI together (the default); claude = Claude products only; openai = ChatGPT and Codex only.' } as const;
const PERIOD_PROP = { type: 'string', description: 'A calendar month as YYYY-MM. Leave out for the current month.' } as const;

// ─── Products ────────────────────────────────────────────────────────────────

/** The product a stored message was typed in, as the pages name it. */
export function productOfMessage(m: { source: string | null; surface: string | null; product: string | null }): string {
  if (isOpenAiSource(m.source)) return OPENAI_SOURCE_LABELS[m.source];
  if (m.product) return m.product; // Claude in Office and Google apps
  if (m.surface === 'code') return 'Claude Code';
  if (m.surface === 'chat') return 'Claude Chat';
  return 'Claude Cowork';
}

/** Message id → product, for alerts that recorded the message but not the product. */
async function productsOfMessages(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const db = await getTypedClient();
  const cm = schema.coworkMessages;
  const rows = await db.select({ id: cm.id, source: cm.source, surface: cm.surface, product: cm.product }).from(cm).where(inArray(cm.id, [...new Set(ids)].slice(0, 1000)));
  for (const r of rows) out.set(r.id, productOfMessage(r));
  return out;
}

// ─── People ──────────────────────────────────────────────────────────────────

interface Person { id: string; name: string; email: string | null; department: string | null }

async function everyone(ctx: LookupContext): Promise<Person[]> {
  const { GET } = await import('@/app/api/users/route');
  const r = await callRoute(ctx, '/api/users', { all: 'true' }, GET as Handler);
  if (!r.ok) return [];
  const rows = (Array.isArray(r.body) ? r.body : (r.body as { users?: unknown[] }).users ?? []) as Array<Record<string, unknown>>;
  return rows.map(u => ({
    id: String(u.id),
    name: String(u.display_name ?? u.name ?? u.email ?? u.id),
    email: typeof u.email === 'string' ? u.email : null,
    department: typeof u.department === 'string' ? u.department : null,
  }));
}

/** People whose name or email contains every word of `query` (case ignored). */
export function matchPeople(people: Person[], query: string): Person[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return people.filter(p => {
    const hay = `${p.name} ${p.email ?? ''}`.toLowerCase();
    return words.every(w => hay.includes(w));
  });
}

async function resolvePerson(ctx: LookupContext, query: string): Promise<{ person: Person } | { result: LookupResult }> {
  const matches = matchPeople(await everyone(ctx), query);
  if (matches.length === 1) return { person: matches[0] };
  if (matches.length === 0) return { result: { data: { not_found: `Nobody matches "${query}".` }, page: null } };
  return { result: { data: { several_match: matches.slice(0, 10).map(p => ({ name: p.name, department: p.department })), note: 'Ask which one is meant, or use the full name.' }, page: null } };
}

// ─── The lookups ─────────────────────────────────────────────────────────────

interface Lookup {
  tool: Anthropic.Tool;
  run: (input: Record<string, unknown>, ctx: LookupContext) => Promise<LookupResult>;
}

const LOOKUPS: Lookup[] = [
  {
    tool: {
      name: 'dashboard',
      description: 'The Dashboard: active people this week and last, events in the last 24 hours, open alerts by severity, sessions and flagged prompts per product (Claude Chat, Claude Cowork, Claude Code, ChatGPT, Codex), average sessions per week, people per day over the last 30 days, the department breakdown and the most active people.',
      input_schema: { type: 'object', properties: { vendor: VENDOR_PROP }, additionalProperties: false },
    },
    run: async (input, ctx) => {
      const { GET } = await import('@/app/api/dashboard/route');
      const r = await callRoute(ctx, '/api/dashboard', { vendor: vendorOf(input) }, GET as Handler);
      if (!r.ok) return unavailable(r.status, 'The Dashboard');
      return { data: pickCompact(r.body, ['vendor', 'stats', 'products', 'productsShown', 'peopleByDay', 'departmentBreakdown', 'topUsers', 'licensedSeats', 'adoptionTargetPct'], { maxItems: 31 }), page: { label: 'Dashboard', href: '/' } };
    },
  },
  {
    tool: {
      name: 'work_pulse',
      description: 'Work Pulse for the whole organisation (non-coding work in Claude Chat, Cowork and ChatGPT): people active and doing deep work, frontier work and who does half of it, tasks by depth tier (with the tier names), the prior period, skill and connector spread, work by product, and human time. window = month (last 30 days, the default) or quarter (the last 13 completed weeks).',
      input_schema: { type: 'object', properties: { vendor: VENDOR_PROP, window: { type: 'string', enum: ['month', 'quarter'] } }, additionalProperties: false },
    },
    run: async (input, ctx) => {
      const { GET } = await import('@/app/api/pulse/org-summary/route');
      const r = await callRoute(ctx, '/api/pulse/org-summary', { vendor: vendorOf(input), window: str(input, 'window') === 'quarter' ? 'quarter' : undefined }, GET as Handler);
      if (!r.ok) return unavailable(r.status, 'Work Pulse');
      const quarter = str(input, 'window') === 'quarter';
      // The card fields keep a "30d" suffix whatever the window: say what they cover.
      const note = quarter
        ? 'This is the quarter view: every figure, including fields ending in 30d, covers the last 13 completed weeks; prior figures cover the 13 weeks before.'
        : 'This is the month view: figures cover the last 30 days; prior figures cover the 30 days before.';
      return { data: { note, ...(pickCompact(r.body, ['tierNames', 'dashboard', 'tierCounts', 'byProduct', 'humanTime', 'sessionOutput', 'modelMix']) as object) }, page: { label: 'Work Pulse', href: '/pulse/cio' } };
    },
  },
  {
    tool: {
      name: 'work_pulse_department',
      description: "One department's Work Pulse: its share of deep work against the rest of the organisation, people active and deep, this month's spend, its metrics and the prior period's, kinds of work only one person does, and its members' figures. period = week (last 7 days), month (last 30 days) or quarter (the last 13 completed weeks, the default).",
      input_schema: { type: 'object', properties: { department: { type: 'string', description: 'The department name, e.g. Legal.' }, vendor: VENDOR_PROP, period: { type: 'string', enum: ['week', 'month', 'quarter'] } }, required: ['department'], additionalProperties: false },
    },
    run: async (input, ctx) => {
      const wanted = str(input, 'department');
      if (!wanted) return { data: { error: 'Name a department.' }, page: null };
      const depts = [...new Set((await everyone(ctx)).map(p => p.department).filter((d): d is string => !!d))];
      const dept = depts.find(d => d.toLowerCase() === wanted.toLowerCase()) ?? depts.find(d => d.toLowerCase().includes(wanted.toLowerCase()));
      if (!dept) return { data: { not_found: `No department called "${wanted}".`, departments: depts.sort() }, page: null };
      const { GET } = await import('@/app/api/pulse/dept/[dept]/route');
      const p = str(input, 'period');
      const period = p === 'month' || p === 'week' ? p : 'quarter';
      const r = await callRoute(ctx, `/api/pulse/dept/${encodeURIComponent(dept)}`, { vendor: vendorOf(input), period }, GET as Handler, { params: Promise.resolve({ dept }) });
      if (!r.ok) return unavailable(r.status, `${dept}'s Work Pulse`);
      return { data: { department: dept, ...(pickCompact(r.body, ['period', 'spendThisMonth', 'metrics', 'priorMetrics', 'concentrationRisk', 'frontier', 'memberRows', 'humanTime', 'delegation']) as object) }, page: { label: `${dept} in Work Pulse`, href: `/pulse/dept?dept=${encodeURIComponent(dept)}` } };
    },
  },
  {
    tool: {
      name: 'departments',
      description: 'Every department and how many people are in it.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
    run: async (_input, ctx) => {
      const counts = new Map<string, number>();
      for (const p of await everyone(ctx)) counts.set(p.department ?? 'No department', (counts.get(p.department ?? 'No department') ?? 0) + 1);
      return { data: [...counts].sort((a, b) => b[1] - a[1]).map(([department, people]) => ({ department, people })), page: { label: 'Departments', href: '/pulse/dept' } };
    },
  },
  {
    tool: {
      name: 'people_scores',
      description: "Every person's Work Pulse figures over the last 30 days: tasks at each depth tier, their scores, the products they use and when they were last active. Use it for questions about who does the most deep work, who has gone quiet, or how one person compares.",
      input_schema: { type: 'object', properties: { vendor: VENDOR_PROP, department: { type: 'string' } }, additionalProperties: false },
    },
    run: async (input, ctx) => {
      const { GET } = await import('@/app/api/pulse/admin/users/route');
      const r = await callRoute(ctx, '/api/pulse/admin/users', { vendor: vendorOf(input) === 'all' ? undefined : vendorOf(input), dept: str(input, 'department') }, GET as Handler);
      if (!r.ok) return unavailable(r.status, 'Work Pulse people');
      return { data: pickCompact(r.body, ['users'], { maxItems: 200 }), page: { label: 'Work Pulse users', href: '/pulse/users' } };
    },
  },
  {
    tool: {
      name: 'people_list',
      description: "The people behind two Work Pulse figures: admin_only = people whose tasks were all routine (no deep work); frontier_half = the people who do half of each product's frontier work. One row per person per product.",
      input_schema: { type: 'object', properties: { list: { type: 'string', enum: ['admin_only', 'frontier_half'] }, window: { type: 'string', enum: ['month', 'quarter'] }, vendor: VENDOR_PROP }, required: ['list'], additionalProperties: false },
    },
    run: async (input, ctx) => {
      const list = str(input, 'list') === 'frontier_half' ? 'frontier-half' : 'admin-only';
      const window = str(input, 'window') === 'quarter' ? 'quarter' : 'month';
      const { GET } = await import('@/app/api/pulse/people/route');
      const r = await callRoute(ctx, '/api/pulse/people', { list, window, vendor: vendorOf(input) }, GET as Handler);
      if (!r.ok) return unavailable(r.status, 'That list');
      return { data: pickCompact(r.body, ['list', 'window', 'start', 'end', 'people', 'tierNames'], { maxItems: 200 }), page: { label: 'People behind the figures', href: `/pulse/people?list=${list}&window=${window}` } };
    },
  },
  {
    tool: {
      name: 'developer_pulse',
      description: 'Developer Pulse (Claude Code and Codex) over the last 30 days against the 30 before: spend, sessions, commits, pull requests opened, engaged time, the work mix, model mix, active repositories, top skills and connectors, spend concentration and the month-end projection.',
      input_schema: { type: 'object', properties: { vendor: VENDOR_PROP }, additionalProperties: false },
    },
    run: async (input, ctx) => {
      const { GET } = await import('@/app/api/pulse/code/org-summary/route');
      const r = await callRoute(ctx, '/api/pulse/code/org-summary', { vendor: vendorOf(input) }, GET as Handler);
      if (!r.ok) return unavailable(r.status, 'Developer Pulse');
      return { data: pickCompact(r.body, ['vendor', 'metrics', 'priorMetrics', 'metricsSplit', 'workMix', 'modelMix', 'activeRepos', 'topSkills', 'topConnectors', 'subagentShare', 'spendConcentration', 'spendProjection', 'humanTime', 'unpricedModels']), page: { label: 'Developer Pulse', href: '/pulse/code' } };
    },
  },
  {
    tool: {
      name: 'developer_value',
      description: 'Developer Pulse Value: measured cost per commit, per pull request, per session and per engaged hour, active developers, and the estimated value and time saved (estimates).',
      input_schema: { type: 'object', properties: { vendor: VENDOR_PROP }, additionalProperties: false },
    },
    run: async (input, ctx) => {
      const { GET } = await import('@/app/api/pulse/code/value/route');
      const r = await callRoute(ctx, '/api/pulse/code/value', { vendor: vendorOf(input) }, GET as Handler);
      if (!r.ok) return unavailable(r.status, 'Developer Value');
      return { data: pickCompact(r.body, ['enabled', 'vendor', 'measured', 'estimate', 'timeSaved', 'observedLift', 'split']), page: { label: 'Developer Value', href: '/pulse/code/value' } };
    },
  },
  {
    tool: {
      name: 'finops_month',
      description: "FinOps for one calendar month: total AI spend (measured), Claude and OpenAI parts, spend per product, per cost centre (with people), unallocated spend, the top spenders, caching savings, the month-end projection against last month, the biggest mover and spend concentration.",
      input_schema: { type: 'object', properties: { period: PERIOD_PROP }, additionalProperties: false },
    },
    run: async (input, ctx) => {
      const { GET } = await import('@/app/api/finance/chargeback/route');
      const r = await callRoute(ctx, '/api/finance/chargeback', { period: periodOf(input) }, GET as Handler);
      if (!r.ok) return unavailable(r.status, 'FinOps');
      const b = r.body as Record<string, unknown>;
      // Cost centres without their per-person lists: the people are in top spenders.
      const centres = Array.isArray(b.costCentres) ? (b.costCentres as Array<Record<string, unknown>>).map(c => ({ ...c, users: undefined, people: Array.isArray(c.users) ? c.users.length : undefined })) : b.costCentres;
      const unalloc = b.unallocated && typeof b.unallocated === 'object' ? { ...(b.unallocated as Record<string, unknown>), users: undefined, people: Array.isArray((b.unallocated as { users?: unknown[] }).users) ? (b.unallocated as { users: unknown[] }).users.length : undefined } : b.unallocated;
      return { data: compact({ period: b.period, status: b.status, monthToDate: b.monthToDate, grandTotalUsd: b.grandTotalUsd, vendors: b.vendors, surfaces: b.surfaces, costCentres: centres, unallocated: unalloc, leaderboard: b.leaderboard, cacheSavingsUsd: b.cacheSavingsUsd, projection: b.projection, projectionByVendor: b.projectionByVendor, insightFacts: (b.insight as { facts?: unknown } | undefined)?.facts, estimated: b.estimated }), page: { label: 'FinOps', href: '/finops' } };
    },
  },
  {
    tool: {
      name: 'spend_trend',
      description: 'Total AI spend per calendar month for up to the last 24 months (null where a month was not measured).',
      input_schema: { type: 'object', properties: { months: { type: 'integer', minimum: 1, maximum: 24 } }, additionalProperties: false },
    },
    run: async (input, ctx) => {
      const months = typeof input.months === 'number' ? Math.min(24, Math.max(1, Math.round(input.months))) : 12;
      const { GET } = await import('@/app/api/finance/trend/route');
      const r = await callRoute(ctx, '/api/finance/trend', { months: String(months) }, GET as Handler);
      if (!r.ok) return unavailable(r.status, 'The spend trend');
      return { data: pickCompact(r.body, ['series']), page: { label: 'FinOps', href: '/finops' } };
    },
  },
  {
    tool: {
      name: 'spend_review',
      description: "Spend Review for one month: spend so far against last month's pace by vendor, how many people make up half the spend, the biggest kinds of work, how many people have a better route waiting, and every person's spend with their main kind of work and their number of better routes.",
      input_schema: { type: 'object', properties: { period: PERIOD_PROP }, additionalProperties: false },
    },
    run: async (input, ctx) => {
      const { GET } = await import('@/app/api/finance/spend-review/route');
      const r = await callRoute(ctx, '/api/finance/spend-review', { period: periodOf(input) }, GET as Handler);
      if (!r.ok) return unavailable(r.status, 'Spend Review');
      return { data: pickCompact(r.body, ['period', 'isCurrentMonth', 'summary', 'people'], { maxItems: 100 }), page: { label: 'Spend Review', href: '/finops/spend-review' } };
    },
  },
  {
    tool: {
      name: 'spend_review_person',
      description: "One person's Spend Review for a month: their spend by product, each kind of work with its spend, typical session against colleagues, and the better routes (a cheaper model, a skill or a connector) with the estimated saving.",
      input_schema: { type: 'object', properties: { person: { type: 'string', description: "The person's name or email." }, period: PERIOD_PROP }, required: ['person'], additionalProperties: false },
    },
    run: async (input, ctx) => {
      const q = str(input, 'person');
      if (!q) return { data: { error: 'Name a person.' }, page: null };
      const found = await resolvePerson(ctx, q);
      if ('result' in found) return found.result;
      const { GET } = await import('@/app/api/finance/spend-review/[userId]/route');
      const r = await callRoute(ctx, `/api/finance/spend-review/${encodeURIComponent(found.person.id)}`, { period: periodOf(input) }, GET as Handler, { params: Promise.resolve({ userId: found.person.id }) });
      if (!r.ok) return unavailable(r.status, `${found.person.name}'s Spend Review`);
      return { data: { person: found.person.name, department: found.person.department, ...(pickCompact(r.body, ['period', 'totals', 'work'], { maxItems: 20 }) as object) }, page: { label: `${found.person.name} in Spend Review`, href: `/finops/spend-review/${encodeURIComponent(found.person.id)}` } };
    },
  },
  {
    tool: {
      name: 'alerts',
      description: "Alerts: the total, counts by status, severity, type, product and person (by_status, by_severity, by_type, by_product, by_person; use these for any count), and each alert, newest first, with its type, severity, status, title, the person it relates to, product and date. Filter by status (open, acknowledged, resolved, dismissed) and category. Never includes the prompt that raised an alert.",
      input_schema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'acknowledged', 'resolved', 'dismissed'] }, category: { type: 'string' } }, additionalProperties: false },
    },
    run: async (input, ctx) => {
      const { GET } = await import('@/app/api/alerts/route');
      const r = await callRoute(ctx, '/api/alerts', { status: str(input, 'status'), category: str(input, 'category') }, GET as Handler);
      if (!r.ok) return unavailable(r.status, 'Alerts');
      const rows = Array.isArray(r.body) ? (r.body as Array<Record<string, unknown>>) : [];
      // Never the explanation or the evidence: they quote or describe the prompt. Only the
      // product is read from the evidence, or, where an alert didn't record one (PII alerts and
      // older intent alerts), from the message it was raised on.
      const evOf = (ev: unknown): { product?: unknown; message_id?: unknown } => {
        try { const o = typeof ev === 'string' ? JSON.parse(ev) : ev; return o && typeof o === 'object' ? o as { product?: unknown; message_id?: unknown } : {}; } catch { return {}; }
      };
      const evs = rows.map(a => evOf(a.raw_evidence));
      const missing = evs.filter(e => typeof e.product !== 'string' && typeof e.message_id === 'string').map(e => e.message_id as string);
      const fromMessages = await productsOfMessages(missing);
      const slim = rows.map((a, i) => {
        const e = evs[i];
        const product = typeof e.product === 'string' ? e.product : typeof e.message_id === 'string' ? fromMessages.get(e.message_id) ?? null : null;
        return { alert_type: a.alert_type, severity: a.severity, status: a.status, title: a.title, person: a.user_display_name ?? null, product, generated_at: a.generated_at };
      });
      // Counts worked out here, so the model never counts a list itself.
      const countBy = (key: keyof (typeof slim)[number]) => {
        const m: Record<string, number> = {};
        for (const a of slim) { const k = String(a[key] ?? 'not recorded'); m[k] = (m[k] ?? 0) + 1; }
        return m;
      };
      return {
        data: compact({ total: rows.length, by_status: countBy('status'), by_severity: countBy('severity'), by_type: countBy('alert_type'), by_product: countBy('product'), by_person: countBy('person'), alerts: slim }, { maxItems: 60 }),
        page: { label: 'Alerts', href: '/alerts' },
      };
    },
  },
  {
    tool: {
      name: 'skills_and_connectors',
      description: "The S&C Board: stats.skill_count and stats.connector_count are how many skills and how many connectors the Board lists (use these for \"how many\"); unclaimed counts; this week's uses and new entries; and up to 30 entries with how many people use each. type = skill or connector narrows the entries; sort = most_used (default) or newest; q filters by name.",
      input_schema: { type: 'object', properties: { type: { type: 'string', enum: ['skill', 'connector'] }, sort: { type: 'string', enum: ['most_used', 'newest'] }, q: { type: 'string' }, department: { type: 'string' } }, additionalProperties: false },
    },
    run: async (input, ctx) => {
      const { GET } = await import('@/app/api/library/route');
      const r = await callRoute(ctx, '/api/library', { type: str(input, 'type'), sort: str(input, 'sort'), q: str(input, 'q'), department: str(input, 'department'), per_page: '30' }, GET as Handler);
      if (!r.ok) return unavailable(r.status, 'The S&C Board');
      return { data: pickCompact(r.body, ['entries', 'total', 'unclaimed_count', 'unclaimed_in_use_count', 'stats', 'capability', 'dept_breakdown'], { maxItems: 30 }), page: { label: 'S&C Board', href: '/library' } };
    },
  },
  {
    tool: {
      name: 'use_cases',
      description: 'Use Cases: how many are declared, adopted, piloting, at risk and not seen, and each use case with its sessions.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
    run: async (_input, ctx) => {
      const summary = await import('@/app/api/use-cases/summary/route');
      const s = await callRoute(ctx, '/api/use-cases/summary', {}, summary.GET as Handler);
      if (!s.ok) return unavailable(s.status, 'Use Cases');
      const list = await import('@/app/api/use-cases/route');
      const l = await callRoute(ctx, '/api/use-cases', { status: 'confirmed' }, list.GET as Handler);
      return { data: compact({ summary: s.body, useCases: l.ok ? l.body : [] }, { maxItems: 40 }), page: { label: 'Use Cases', href: '/use-cases' } };
    },
  },
  {
    tool: {
      name: 'find_person',
      description: 'Find people by name or email: their name and department. Use it before naming someone, or when a name matches several people.',
      input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
    },
    run: async (input, ctx) => {
      const q = str(input, 'name');
      if (!q) return { data: { error: 'Give a name.' }, page: null };
      const matches = matchPeople(await everyone(ctx), q).slice(0, 15).map(p => ({ name: p.name, department: p.department }));
      return { data: { matches }, page: null };
    },
  },
  {
    tool: {
      name: 'calculate',
      description: 'Arithmetic done in code. You must use this for every figure that is not already in a lookup: a change between two figures (op change: from, to), a share (op share: part, whole), a sum (op sum: values) or a difference (op difference: from, to). Copy the inputs exactly from lookups.',
      input_schema: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['change', 'share', 'sum', 'difference'] },
          from: { type: 'number' }, to: { type: 'number' },
          part: { type: 'number' }, whole: { type: 'number' },
          values: { type: 'array', items: { type: 'number' } },
        },
        required: ['op'],
        additionalProperties: false,
      },
    },
    run: async (input) => ({ data: calculate(input), page: null }),
  },
  {
    tool: {
      name: 'cannot_answer',
      description: 'Use when no lookup covers the question, or it asks for something Ask the data never gives: prompt text, reasons the data does not show, forecasts beyond the projections the pages show, or anything that is not about this organisation\'s AI use. Say briefly why.',
      input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'], additionalProperties: false },
    },
    run: async () => ({ data: { noted: true }, page: null }),
  },
];

export const LOOKUP_TOOLS: Anthropic.Tool[] = LOOKUPS.map(l => l.tool);

/** Pure: the arithmetic behind the calculate lookup, rounded to two decimal places. */
export function calculate(input: Record<string, unknown>): Record<string, unknown> {
  const num = (k: string) => (typeof input[k] === 'number' && Number.isFinite(input[k] as number) ? (input[k] as number) : null);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  switch (input.op) {
    case 'change': {
      const from = num('from'), to = num('to');
      if (from === null || to === null) return { error: 'change needs from and to.' };
      return { from, to, difference: r2(to - from), percent_change: from === 0 ? null : r2(((to - from) / Math.abs(from)) * 100) };
    }
    case 'difference': {
      const from = num('from'), to = num('to');
      if (from === null || to === null) return { error: 'difference needs from and to.' };
      return { from, to, difference: r2(to - from) };
    }
    case 'share': {
      const part = num('part'), whole = num('whole');
      if (part === null || whole === null) return { error: 'share needs part and whole.' };
      return { part, whole, percent: whole === 0 ? null : r2((part / whole) * 100) };
    }
    case 'sum': {
      const values = Array.isArray(input.values) ? input.values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)) : [];
      if (values.length === 0) return { error: 'sum needs values.' };
      return { values, sum: r2(values.reduce((a, b) => a + b, 0)) };
    }
    default:
      return { error: 'op must be change, share, sum or difference.' };
  }
}

/** Run one lookup by name. Unknown names and bad input come back as data the model can read. */
export async function runLookup(name: string, input: unknown, ctx: LookupContext): Promise<LookupResult> {
  const lookup = LOOKUPS.find(l => l.tool.name === name);
  if (!lookup) return { data: { error: `There is no lookup called ${name}.` }, page: null };
  const obj = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  return lookup.run(obj, ctx);
}
