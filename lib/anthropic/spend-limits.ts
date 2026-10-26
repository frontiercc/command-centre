// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Anthropic Spend Limits API client (Claude Enterprise only), read-only.
// Docs: https://platform.claude.com/docs/en/manage-claude/spend-limits-api
//
//   GET /v1/organizations/spend_limits/effective          each member's limit + spend this period
//   GET /v1/organizations/spend_limit_increase_requests   members' "Request more usage" clicks
//
// Needs an Admin API key with `read:spend_limits` (config key
// `anthropicAdminApiKey`). Dormant without one: no call is made. CCC never
// calls the write endpoints (set/delete a limit, approve/deny a request) —
// changing anything in a customer's Anthropic account is a separate decision.
//
// UNVERIFIED against a live tenant until the sandbox smoke (the shapes below
// follow the published API reference).
//
// Amounts are decimal strings in MINOR units (cents for USD) and may carry
// fractional cents. `amount: null` on an effective row means NO LIMIT, `"0"`
// means included usage only. All endpoints share 60 requests/minute per org,
// so results are cached in-process for CACHE_TTL_MS.
import { getConfigValue } from '@/lib/config';
import { logError } from '@/lib/api/errors';

const BASE = 'https://api.anthropic.com/v1/organizations';
const CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
/** Pages of up to 1,000 members each — 10,000 members before we stop. */
const MAX_PAGES = 10;

export type SpendLimitPeriod = 'daily' | 'weekly' | 'monthly' | string;

export interface SpendLimitRow {
  period: SpendLimitPeriod;
  /** Limit in major units (dollars), null = unlimited. */
  limit: number | null;
  /** Spend so far this period, major units. */
  spend: number;
  currency: string;
  /** Where the limit comes from, in plain words. */
  source: string;
}

export interface SpendLimitMember {
  anthropicUserId: string;
  email: string | null;
  name: string | null;
  rows: SpendLimitRow[];
}

export interface IncreaseRequest {
  id: string;
  anthropicUserId: string;
  email: string | null;
  name: string | null;
  createdAt: string;
  period: SpendLimitPeriod;
  /** The live spend summary Anthropic attaches to a pending request. */
  summary: SpendLimitRow | null;
}

export type SpendLimitsStatus =
  | 'not_configured'   // no admin key saved
  | 'ok'
  | 'invalid_key'      // 401
  | 'missing_scope'    // 403: key valid but lacks read:spend_limits, not Enterprise, or usage credits off
  | 'not_available'    // 404
  | 'error';           // network, 429, 5xx, malformed body

export interface SpendLimitsSnapshot {
  status: SpendLimitsStatus;
  fetchedAt: number | null;
  members: SpendLimitMember[];
  pendingRequests: IncreaseRequest[];
}

// ─── Pure mapping ────────────────────────────────────────────────────────────

/** Minor-unit decimal string → major units. Null/blank/garbage → null. */
export function parseMinorUnits(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n / 100 : null;
}

interface RawActor {
  type?: string;
  user_id?: string;
  email_address?: string | null;
  name?: string | null;
}

interface RawScope { type?: string; seat_tier?: string; rbac_group_id?: string; service?: string }

interface RawSpendSummary {
  actor?: RawActor;
  amount?: string | null;
  currency?: string;
  period?: string;
  period_to_date_spend?: string;
  source?: RawScope;
}

interface RawIncreaseRequest {
  id?: string;
  actor?: RawActor;
  created_at?: string;
  period?: string;
  status?: string;
  spend_summary?: RawSpendSummary | null;
}

/** Plain-words label for where a limit is inherited from. Unknown types fall through. */
export function sourceLabel(source: RawScope | undefined): string {
  switch (source?.type) {
    case 'user': return 'Set for this person';
    case 'seat_tier': return source.seat_tier ? `Seat type default (${source.seat_tier.replace(/_/g, ' ')})` : 'Seat type default';
    case 'rbac_group': return 'Group default';
    case 'organization': return 'Organisation default';
    case undefined: return 'Unknown';
    default: return String(source?.type).replace(/_/g, ' ');
  }
}

export function mapSummary(raw: RawSpendSummary): SpendLimitRow {
  return {
    period: raw.period ?? 'monthly',
    limit: parseMinorUnits(raw.amount),
    spend: parseMinorUnits(raw.period_to_date_spend) ?? 0,
    currency: raw.currency ?? 'USD',
    source: sourceLabel(raw.source),
  };
}

/** Group effective rows by member. Rows from a non-user actor (a scoped API key) are skipped. */
export function mapEffectiveRows(rows: RawSpendSummary[]): SpendLimitMember[] {
  const byUser = new Map<string, SpendLimitMember>();
  for (const r of rows) {
    const actor = r.actor;
    if (!actor || actor.type !== 'user_actor' || !actor.user_id) continue;
    let m = byUser.get(actor.user_id);
    if (!m) {
      m = { anthropicUserId: actor.user_id, email: actor.email_address ?? null, name: actor.name ?? null, rows: [] };
      byUser.set(actor.user_id, m);
    }
    m.rows.push(mapSummary(r));
  }
  return [...byUser.values()];
}

export function mapIncreaseRequests(rows: RawIncreaseRequest[]): IncreaseRequest[] {
  const out: IncreaseRequest[] = [];
  for (const r of rows) {
    const actor = r.actor;
    if (!r.id || !actor || actor.type !== 'user_actor' || !actor.user_id) continue;
    if (r.status && r.status !== 'pending') continue;
    out.push({
      id: r.id,
      anthropicUserId: actor.user_id,
      email: actor.email_address ?? null,
      name: actor.name ?? null,
      createdAt: r.created_at ?? '',
      period: r.period ?? 'monthly',
      summary: r.spend_summary ? mapSummary(r.spend_summary) : null,
    });
  }
  return out;
}

/** The row a monthly review should show: monthly first, else the first row. */
export function primaryRow(member: SpendLimitMember | undefined): SpendLimitRow | null {
  if (!member || member.rows.length === 0) return null;
  return member.rows.find(r => r.period === 'monthly') ?? member.rows[0];
}

/** Share of the limit used. Null when unlimited; a zero limit reads as used up. */
export function shareUsed(row: SpendLimitRow | null): number | null {
  if (!row || row.limit === null) return null;
  if (row.limit === 0) return 1;
  return row.spend / row.limit;
}

/** At or above this share of the limit, a person is flagged as close to it. */
export const NEAR_LIMIT_SHARE = 0.8;

// ─── HTTP ────────────────────────────────────────────────────────────────────

class SpendLimitsHttpError extends Error {
  constructor(public status: number) {
    super(`Spend Limits API error ${status}`);
    this.name = 'SpendLimitsHttpError';
  }
}

async function getJson<T>(apiKey: string, path: string, params: Array<[string, string]>): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of params) url.searchParams.append(k, v);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: controller.signal,
    });
    if (!res.ok) throw new SpendLimitsHttpError(res.status);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function getAllPages<T>(apiKey: string, path: string, params: Array<[string, string]>): Promise<T[]> {
  const out: T[] = [];
  let page: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const body: { data?: T[]; next_page?: string | null } = await getJson(apiKey, path, page ? [...params, ['page', page]] : params);
    out.push(...(body.data ?? []));
    page = body.next_page ?? null;
    if (!page) break;
  }
  return out;
}

export function statusForError(err: unknown): SpendLimitsStatus {
  if (err instanceof SpendLimitsHttpError) {
    if (err.status === 401) return 'invalid_key';
    if (err.status === 403) return 'missing_scope';
    if (err.status === 404) return 'not_available';
  }
  return 'error';
}

/** Fetch every member's effective limits and the pending increase requests. Never throws. */
export async function fetchSpendLimits(apiKey: string, nowMs: number = Date.now()): Promise<SpendLimitsSnapshot> {
  try {
    const [effective, requests] = await Promise.all([
      getAllPages<RawSpendSummary>(apiKey, '/spend_limits/effective', [['limit', '1000']]),
      getAllPages<RawIncreaseRequest>(apiKey, '/spend_limit_increase_requests', [['status[]', 'pending'], ['limit', '1000']]),
    ]);
    return {
      status: 'ok',
      fetchedAt: Math.floor(nowMs / 1000),
      members: mapEffectiveRows(effective),
      pendingRequests: mapIncreaseRequests(requests),
    };
  } catch (err) {
    const status = statusForError(err);
    // Expected states (no scope, wrong plan) are not server faults; log the rest.
    if (status === 'error') logError('anthropic/spend-limits', err);
    return { status, fetchedAt: null, members: [], pendingRequests: [] };
  }
}

// ─── Cached read for the routes ──────────────────────────────────────────────

let cache: { key: string; at: number; snapshot: SpendLimitsSnapshot } | null = null;

/**
 * The current snapshot, from cache when fresh. `not_configured` (and no call)
 * when no admin key is saved. Only an `ok` snapshot is cached, so a fixed key
 * or a newly granted scope shows on the next page load.
 */
export async function getSpendLimits(opts: { force?: boolean } = {}): Promise<SpendLimitsSnapshot> {
  const apiKey = (await getConfigValue('anthropicAdminApiKey'))?.trim();
  if (!apiKey) return { status: 'not_configured', fetchedAt: null, members: [], pendingRequests: [] };
  const now = Date.now();
  if (!opts.force && cache && cache.key === apiKey && now - cache.at < CACHE_TTL_MS) return cache.snapshot;
  const snapshot = await fetchSpendLimits(apiKey, now);
  if (snapshot.status === 'ok') cache = { key: apiKey, at: now, snapshot };
  return snapshot;
}

/** Index members and requests by lower-cased email, the join to CCC's users. */
export function indexByEmail(snapshot: SpendLimitsSnapshot): {
  members: Map<string, SpendLimitMember>;
  requests: Map<string, IncreaseRequest>;
} {
  const members = new Map<string, SpendLimitMember>();
  for (const m of snapshot.members) if (m.email) members.set(m.email.toLowerCase(), m);
  const requests = new Map<string, IncreaseRequest>();
  for (const r of snapshot.pendingRequests) if (r.email && !requests.has(r.email.toLowerCase())) requests.set(r.email.toLowerCase(), r);
  return { members, requests };
}
