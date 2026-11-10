// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Department sync: keeps each person's department in step with the
 * organisation's directory (Microsoft Entra ID today; the provider is chosen
 * from the single sign-on issuer, so Google Workspace can be added beside it).
 *
 * Two triggers, one set of rules (lib/directory/department-rules.ts):
 * - sign-in: the signed-in person's own department, read with their token;
 * - daily lookup: everyone Command Centre knows, matched by email against the
 *   whole directory, including people who never sign in.
 *
 * Nothing is written until an admin applies the first-run preview
 * (departmentSyncAppliedAt). Only departments are ever written: never a role,
 * single sign-on access, or an account. A person is their login account
 * (admin_users) plus their monitored record(s) (users), joined by the account
 * link and by email; both are written together, and every change is recorded
 * in department_history.
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { getTypedClient } from '@/lib/db/client';
import * as schema from '@/lib/db/schema.pg';
import { getAllConfig, getConfigValue, setConfigValue } from '@/lib/config';
import { insertErrorEvents } from '@/lib/db/error-queries';
import {
  DepartmentResolver, decideDepartment, parseDepartmentMap, tidyDepartment,
  type DepartmentSource, type MatchedBy,
} from '@/lib/directory/department-rules';
import {
  entraEndpoints, readSignedInEntra, appOnlyToken, listEntraUsers, DirectoryPermissionError,
  type DirectoryEntry, type EntraEndpoints,
} from '@/lib/directory/entra';

// ─── Provider ───────────────────────────────────────────────────────────────

export type DirectoryProvider =
  | { kind: 'entra'; label: 'Microsoft Entra ID'; endpoints: EntraEndpoints; clientId: string; clientSecret: string }
  | { kind: 'unsupported'; label: string }
  | { kind: 'none' };

/** The directory behind the configured single sign-on, if department sync supports it. */
export async function getDirectoryProvider(): Promise<DirectoryProvider> {
  const cfg = await getAllConfig();
  if (!cfg.ssoIssuerUrl || !cfg.ssoClientId || !cfg.ssoClientSecret) return { kind: 'none' };
  const endpoints = entraEndpoints(cfg.ssoIssuerUrl);
  if (!endpoints) return { kind: 'unsupported', label: cfg.ssoProviderLabel || 'your provider' };
  return { kind: 'entra', label: 'Microsoft Entra ID', endpoints, clientId: cfg.ssoClientId, clientSecret: cfg.ssoClientSecret };
}

// ─── People ─────────────────────────────────────────────────────────────────

interface AdminRow { id: string; email: string; department: string | null; department_source: string | null; linked_cowork_user_id: string | null }
interface UserRow { id: string; email: string | null; display_name: string | null; department: string | null; department_source: string | null }

interface Person {
  admin: AdminRow | null;
  users: UserRow[];
  emails: string[];
}

const asSource = (s: string | null): DepartmentSource => (s === 'directory' || s === 'manual' ? s : null);

/** Every person with at least one email: login account and monitored records joined. */
async function loadPeople(): Promise<Person[]> {
  const db = await getTypedClient();
  const admins = await db.select({
    id: schema.adminUsers.id, email: schema.adminUsers.email, department: schema.adminUsers.department,
    department_source: schema.adminUsers.department_source, linked_cowork_user_id: schema.adminUsers.linked_cowork_user_id,
  }).from(schema.adminUsers) as AdminRow[];
  const users = await db.select({
    id: schema.users.id, email: schema.users.email, display_name: schema.users.display_name,
    department: schema.users.department, department_source: schema.users.department_source,
  }).from(schema.users) as UserRow[];

  const userById = new Map(users.map(u => [u.id, u]));
  const attached = new Set<string>();
  const people: Person[] = [];
  const byEmail = new Map<string, Person>();

  for (const a of admins) {
    const p: Person = { admin: a, users: [], emails: [] };
    const linked = a.linked_cowork_user_id ? userById.get(a.linked_cowork_user_id) : undefined;
    if (linked) { p.users.push(linked); attached.add(linked.id); }
    people.push(p);
    byEmail.set(String(a.email).toLowerCase(), p);
  }
  for (const u of users) {
    if (attached.has(u.id) || !u.email) continue;
    const key = u.email.toLowerCase();
    const p = byEmail.get(key);
    if (p) { p.users.push(u); attached.add(u.id); continue; }
    const fresh: Person = { admin: null, users: [u], emails: [] };
    people.push(fresh);
    byEmail.set(key, fresh);
  }
  for (const p of people) {
    const emails = new Set<string>();
    if (p.admin?.email) emails.add(String(p.admin.email).toLowerCase());
    for (const u of p.users) if (u.email) emails.add(u.email.toLowerCase());
    p.emails = [...emails];
  }
  return people.filter(p => p.emails.length > 0);
}

function currentDepartment(p: Person): string | null {
  const fromAdmin = tidyDepartment(p.admin?.department);
  if (fromAdmin) return fromAdmin;
  for (const u of p.users) {
    const d = tidyDepartment(u.department);
    if (d) return d;
  }
  return null;
}

function sourcesOf(p: Person): DepartmentSource[] {
  return [...(p.admin ? [asSource(p.admin.department_source)] : []), ...p.users.map(u => asSource(u.department_source))];
}

/** Every department in use, on login accounts and monitored people. */
async function existingDepartments(): Promise<string[]> {
  const db = await getTypedClient();
  const a = await db.selectDistinct({ d: schema.adminUsers.department }).from(schema.adminUsers);
  const u = await db.selectDistinct({ d: schema.users.department }).from(schema.users);
  return [...a, ...u].map(r => r.d).filter((d): d is string => typeof d === 'string' && d.trim() !== '');
}

// ─── Applying directory entries ─────────────────────────────────────────────

export type SyncOrigin = 'sign_in' | 'daily' | 'apply' | 'run_now' | 'preview';

export interface NameRow {
  /** The name as the directory holds it (tidied). */
  directoryName: string;
  /** The Command Centre department it lands on. */
  department: string;
  matchedBy: MatchedBy;
  people: number;
}

export interface SyncStats {
  at: number;
  origin: SyncOrigin;
  /** People Command Centre knows with an email. */
  people: number;
  /** Of those, found in the directory. */
  inDirectory: number;
  updated: number;
  unchanged: number;
  /** Kept because an admin set the department by hand. */
  manual: number;
  /** Found, but the directory's department is empty. */
  emptyInDirectory: number;
  notFound: number;
  /** Up to 50 people not found (monitored-person id, else login account id). */
  notFoundIds: string[];
  /** Directory names and where each lands. */
  names: NameRow[];
  /** Names that became new departments and are not yet in the name map. */
  newNames: string[];
  error?: { kind: 'permission' | 'failed'; message: string };
}

const NOT_FOUND_LIST_CAP = 50;

interface ApplyOptions {
  origin: SyncOrigin;
  write: boolean;
  /** Restrict to these emails (sign-in): people outside are neither counted nor written. */
  onlyEmails?: string[];
  nowS?: number;
}

export async function applyDirectoryEntries(entries: DirectoryEntry[], opts: ApplyOptions): Promise<SyncStats> {
  const nowS = opts.nowS ?? Math.floor(Date.now() / 1000);
  const map = parseDepartmentMap(await getConfigValue('departmentSyncMap'));
  const resolver = new DepartmentResolver(await existingDepartments(), map);

  const entryByEmail = new Map<string, DirectoryEntry>();
  for (const e of entries) for (const email of e.emails) if (!entryByEmail.has(email)) entryByEmail.set(email, e);

  let people = await loadPeople();
  if (opts.onlyEmails) {
    const only = new Set(opts.onlyEmails.map(e => e.toLowerCase()));
    people = people.filter(p => p.emails.some(e => only.has(e)));
  }

  const stats: SyncStats = {
    at: nowS, origin: opts.origin, people: people.length, inDirectory: 0, updated: 0, unchanged: 0,
    manual: 0, emptyInDirectory: 0, notFound: 0, notFoundIds: [], names: [], newNames: [],
  };
  const names = new Map<string, NameRow>();
  const db = await getTypedClient();

  for (const p of people) {
    const entry = p.emails.map(e => entryByEmail.get(e)).find(Boolean);
    if (!entry) {
      stats.notFound += 1;
      const id = p.users[0]?.id ?? p.admin?.id;
      if (id && stats.notFoundIds.length < NOT_FOUND_LIST_CAP) stats.notFoundIds.push(id);
      continue;
    }
    stats.inDirectory += 1;
    const resolved = resolver.resolve(entry.department);
    if (resolved) {
      const directoryName = tidyDepartment(entry.department);
      const row = names.get(directoryName.toLowerCase()) ?? { directoryName, department: resolved.department, matchedBy: resolved.matchedBy, people: 0 };
      row.people += 1;
      names.set(directoryName.toLowerCase(), row);
    }
    const decision = decideDepartment({ current: currentDepartment(p), sources: sourcesOf(p) }, resolved);
    if (decision.action === 'skip') {
      if (decision.reason === 'manual') stats.manual += 1; else stats.emptyInDirectory += 1;
      continue;
    }
    if (decision.action === 'unchanged') stats.unchanged += 1; else stats.updated += 1;
    if (!opts.write) continue;

    const set = { department: decision.department, department_source: 'directory', department_synced_at: nowS };
    if (p.admin) await db.update(schema.adminUsers).set(set).where(eq(schema.adminUsers.id, p.admin.id));
    const userIds = p.users.map(u => u.id);
    if (userIds.length > 0) await db.update(schema.users).set(set).where(inArray(schema.users.id, userIds));
    if (decision.action === 'change') {
      await db.insert(schema.departmentHistory).values({
        id: randomUUID(),
        user_id: p.users[0]?.id ?? null,
        admin_user_id: p.admin?.id ?? null,
        from_department: currentDepartment(p),
        to_department: decision.department,
        source: 'directory',
        is_move: decision.isMove ? 1 : 0,
        changed_at: nowS,
      });
    }
  }

  stats.names = [...names.values()].sort((a, b) => b.people - a.people || a.directoryName.localeCompare(b.directoryName));
  const mapKeys = new Set(Object.keys(map).map(k => k.toLowerCase()));
  stats.newNames = stats.names.filter(n => n.matchedBy === 'new' && !mapKeys.has(n.directoryName.toLowerCase())).map(n => n.directoryName);
  return stats;
}

// ─── Triggers ───────────────────────────────────────────────────────────────

async function recordFailure(origin: SyncOrigin, err: unknown): Promise<void> {
  try {
    await insertErrorEvents([{
      severity: 'warning',
      source: 'department-sync',
      message: `Department sync (${origin}) failed: ${err instanceof Error ? err.message : String(err)}`,
      context_json: JSON.stringify({ origin }),
    }]);
  } catch { /* the database may be what failed */ }
}

export async function isDepartmentSyncActive(): Promise<boolean> {
  return (await getConfigValue('departmentSyncEnabled')) === 'true' && !!(await getConfigValue('departmentSyncAppliedAt'));
}

/**
 * At sign-in, after the person is authorised. Never throws and never stops
 * the sign-in: any failure is recorded and their department stays as it was.
 */
export async function syncDepartmentAtSignIn(email: string, accessToken: string | undefined, fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    if (!accessToken || !(await isDepartmentSyncActive())) return;
    const provider = await getDirectoryProvider();
    if (provider.kind !== 'entra') return;
    const entry = await readSignedInEntra(provider.endpoints, accessToken, fetchImpl);
    // Match on the account that signed in, whatever addresses the directory lists.
    await applyDirectoryEntries([{ ...entry, emails: [...new Set([...entry.emails, email.toLowerCase()])] }], {
      origin: 'sign_in', write: true, onlyEmails: [email],
    });
  } catch (err) {
    await recordFailure('sign_in', err);
  }
}

async function listDirectory(fetchImpl: typeof fetch): Promise<DirectoryEntry[]> {
  const provider = await getDirectoryProvider();
  if (provider.kind !== 'entra') throw new Error('Department sync needs single sign-on with Microsoft Entra ID');
  const token = await appOnlyToken(provider.endpoints, provider.clientId, provider.clientSecret, fetchImpl);
  return listEntraUsers(provider.endpoints, token, fetchImpl);
}

/** Shown on the admin page; the underlying error text goes to error_events, never to the page. */
const FAILED_MESSAGE = "Couldn't reach Microsoft Entra ID. The detail is in System health.";

/** The stats error for a failure: a permission refusal names what to fix; anything else is fixed text. */
function errorFor(err: unknown): NonNullable<SyncStats['error']> {
  return err instanceof DirectoryPermissionError
    ? { kind: 'permission', message: err.message }
    : { kind: 'failed', message: FAILED_MESSAGE };
}

function emptyStats(origin: SyncOrigin, nowS: number, error: SyncStats['error']): SyncStats {
  return { at: nowS, origin, people: 0, inDirectory: 0, updated: 0, unchanged: 0, manual: 0, emptyInDirectory: 0, notFound: 0, notFoundIds: [], names: [], newNames: [], error };
}

/** What the first apply would do, writing nothing. */
export async function previewDepartmentSync(fetchImpl: typeof fetch = fetch): Promise<SyncStats> {
  const nowS = Math.floor(Date.now() / 1000);
  try {
    return await applyDirectoryEntries(await listDirectory(fetchImpl), { origin: 'preview', write: false, nowS });
  } catch (err) {
    if (!(err instanceof DirectoryPermissionError)) await recordFailure('preview', err);
    return emptyStats('preview', nowS, errorFor(err));
  }
}

/**
 * A full lookup that writes: the first-run Apply, Run now, and the daily job.
 * A missing User.Read.All permission is not a failure: it is recorded in the
 * stats (the admin page explains it) and departments update at sign-in only.
 * Any other error is thrown, so the daily job shows in System health.
 */
export async function runDepartmentSync(origin: 'apply' | 'run_now' | 'daily', fetchImpl: typeof fetch = fetch): Promise<SyncStats> {
  const nowS = Math.floor(Date.now() / 1000);
  let stats: SyncStats;
  try {
    stats = await applyDirectoryEntries(await listDirectory(fetchImpl), { origin, write: true, nowS });
  } catch (err) {
    if (!(err instanceof DirectoryPermissionError)) {
      await setConfigValue('departmentSyncLastStats', JSON.stringify(emptyStats(origin, nowS, errorFor(err))));
      // The daily job's failure is recorded by runJob; Apply and Run now record it here.
      if (origin !== 'daily') await recordFailure(origin, err);
      throw err;
    }
    stats = emptyStats(origin, nowS, errorFor(err));
  }
  // Names that became new departments stay listed until an admin maps them.
  try {
    const prev = JSON.parse((await getConfigValue('departmentSyncLastStats')) || '{}') as Partial<SyncStats>;
    const map = parseDepartmentMap(await getConfigValue('departmentSyncMap'));
    const mapped = new Set(Object.keys(map).map(k => k.toLowerCase()));
    stats.newNames = [...new Set([...(prev.newNames ?? []), ...stats.newNames])].filter(n => !mapped.has(n.toLowerCase()));
  } catch { /* first run */ }
  await setConfigValue('departmentSyncLastStats', JSON.stringify(stats));
  await setConfigValue('departmentSyncLastRun', String(nowS));
  return stats;
}

/** Due once a day, after the first apply. */
export async function departmentSyncDue(nowS: number = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const last = Number(await getConfigValue('departmentSyncLastRun')) || 0;
  return nowS - last >= 20 * 3600;
}

// ─── Manual edits ───────────────────────────────────────────────────────────

/**
 * An admin set a department by hand: mark it manual so the sync leaves it
 * alone, and record the change. Called by the two admin edit routes.
 */
export async function recordManualDepartment(opts: {
  adminUserId?: string | null;
  userIds?: string[];
  from: string | null;
  to: string | null;
}): Promise<void> {
  const db = await getTypedClient();
  const nowS = Math.floor(Date.now() / 1000);
  const set = { department_source: 'manual' };
  if (opts.adminUserId) await db.update(schema.adminUsers).set(set).where(eq(schema.adminUsers.id, opts.adminUserId));
  const userIds = (opts.userIds ?? []).filter(Boolean);
  if (userIds.length > 0) await db.update(schema.users).set(set).where(inArray(schema.users.id, userIds));
  if (tidyDepartment(opts.from) === tidyDepartment(opts.to)) return;
  await db.insert(schema.departmentHistory).values({
    id: randomUUID(),
    user_id: userIds[0] ?? null,
    admin_user_id: opts.adminUserId ?? null,
    from_department: tidyDepartment(opts.from) || null,
    to_department: tidyDepartment(opts.to) || null,
    source: 'manual',
    is_move: 0,
    changed_at: nowS,
  });
}

/** "Return to directory": the next lookup or sign-in may set the department again. */
export async function returnToDirectory(opts: { adminUserId?: string | null; userIds?: string[] }): Promise<void> {
  const db = await getTypedClient();
  const set = { department_source: null };
  if (opts.adminUserId) await db.update(schema.adminUsers).set(set).where(eq(schema.adminUsers.id, opts.adminUserId));
  const userIds = (opts.userIds ?? []).filter(Boolean);
  if (userIds.length > 0) await db.update(schema.users).set(set).where(inArray(schema.users.id, userIds));
}
