// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Every API route handler refuses every role that
// must not call it.
//
// test/api-route-authz-coverage.test.ts proves each handler CONTAINS a role
// gate. This proves the gate WORKS: it calls every handler, as an
// unauthenticated caller and as each role outside the handler's allowed set in
// test/helpers/route-role-matrix.ts, and asserts a 401/403.
//
// Sessions are real: one admin_users row + admin_sessions row per role in a
// fresh migrated Postgres database, sent as the ccc_session cookie. Nothing in
// lib/auth is mocked, so requireAdmin, the canAccess* helpers and
// gateContentRead all run as they do in production. Only two
// things are replaced: the access audit log (a no-op) and every *Enabled
// feature flag (forced on, so a flag-404-before-auth route reaches its role
// check).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { createTestDatabase } from './helpers/db';
import { ROUTE_ROLE_MATRIX, ALL_ROLES, type Role, type MatrixEntry } from './helpers/route-role-matrix';

vi.mock('@/lib/audit/log', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/audit/log')>();
  return { ...actual, logAccess: vi.fn(async () => {}) };
});

vi.mock('@/lib/config', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/config')>();
  return {
    ...actual,
    getConfigValue: vi.fn(async (key: string) =>
      key.endsWith('Enabled') ? 'true' : actual.getConfigValue(key as Parameters<typeof actual.getConfigValue>[0])),
    getAllConfig: vi.fn(async () => {
      const cfg = { ...(await actual.getAllConfig()) } as unknown as Record<string, unknown>;
      for (const k of Object.keys(cfg)) if (k.endsWith('Enabled')) cfg[k] = true;
      return cfg;
    }),
  };
});

const API_ROOT = path.join(__dirname, '..', 'app', 'api');
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// Same discovery as test/api-route-authz-coverage.test.ts.
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === 'route.ts') out.push(p);
  }
  return out;
}

function discoverHandlers(): string[] {
  const keys: string[] = [];
  for (const f of walk(API_ROOT)) {
    const rel = path.relative(API_ROOT, path.dirname(f)).split(path.sep).join('/');
    const parts = fs.readFileSync(f, 'utf8').split(/export async function (GET|POST|PUT|PATCH|DELETE)\b/);
    for (let i = 1; i < parts.length; i += 2) keys.push(`${rel} ${parts[i]}`);
  }
  return keys.sort();
}

function allowedRoles(entry: MatrixEntry): readonly Role[] | null {
  if (entry === 'NON_SESSION') return null;
  if (entry === 'SELF_OR_DATA') return ALL_ROLES; // only unauthenticated is asserted
  return Array.isArray(entry) ? entry : (entry as { roles: readonly Role[] }).roles;
}

function queryOf(entry: MatrixEntry): string {
  return typeof entry === 'object' && !Array.isArray(entry) ? `?${(entry as { query: string }).query}` : '';
}

function paramsFor(routePath: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const m of routePath.matchAll(/\[(\w+)\]/g)) params[m[1]] = 'x';
  return params;
}

function buildRequest(routePath: string, method: Method, query: string, sessionId: string | null): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json', host: 'localhost' };
  if (sessionId) headers.cookie = `ccc_session=${sessionId}`;
  return new NextRequest(`http://localhost/api/${routePath}${query}`, {
    method,
    headers,
    body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
  });
}

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

let cleanup: (() => Promise<void>) | null = null;
const sessionByRole = new Map<Role, string>();
let assertions = 0;

beforeAll(async () => {
  const db = await createTestDatabase();
  cleanup = db.cleanup;
  const { createAdminUser, createSession } = await import('@/lib/db/admin-queries');
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  for (const role of ALL_ROLES) {
    const user = await createAdminUser({
      email: `role-matrix-${role}@test.local`,
      passwordHash: 'x',
      displayName: `Role Matrix ${role}`,
      role,
      department: 'Role Matrix Dept',
    });
    const s = await createSession({ userId: user.id, expiresAt });
    sessionByRole.set(role, s.id);
  }
}, 120_000);

afterAll(async () => {
  // eslint-disable-next-line no-console
  console.log(`[role-matrix] ${assertions} refusal assertions`);
  await cleanup?.();
});

const discovered = discoverHandlers();

describe('API route role matrix', () => {
  it('covers exactly the discovered route handlers', () => {
    const matrixKeys = Object.keys(ROUTE_ROLE_MATRIX).sort();
    const missing = discovered.filter((k) => !(k in ROUTE_ROLE_MATRIX));
    const stale = matrixKeys.filter((k) => !discovered.includes(k));
    expect(missing, `Handlers with no matrix entry — decide who may call them:\n${missing.join('\n')}`).toEqual([]);
    expect(stale, `Matrix entries with no handler:\n${stale.join('\n')}`).toEqual([]);
    expect(discovered.length).toBeGreaterThan(150);
  });

  const sessionRoutes = Object.entries(ROUTE_ROLE_MATRIX).filter(([, e]) => e !== 'NON_SESSION');

  it.each(sessionRoutes)('%s refuses unauthenticated callers and roles outside its set', async (key, entry) => {
    const [routePath, method] = key.split(' ') as [string, Method];
    const allowed = allowedRoles(entry)!;
    const query = queryOf(entry);
    const mod = (await import(/* @vite-ignore */ `@/app/api/${routePath}/route`)) as Record<string, Handler>;
    const handler = mod[method];
    expect(handler, `${key} is not exported`).toBeTypeOf('function');

    const callers: Array<{ label: string; sessionId: string | null }> = [{ label: 'unauthenticated', sessionId: null }];
    for (const role of ALL_ROLES) {
      if (!allowed.includes(role)) callers.push({ label: role, sessionId: sessionByRole.get(role)! });
    }

    const wrong: string[] = [];
    for (const c of callers) {
      let status: number | string;
      try {
        const res = await handler(buildRequest(routePath, method, query, c.sessionId), {
          params: Promise.resolve(paramsFor(routePath)),
        });
        status = res.status;
      } catch (err) {
        status = `threw ${(err as Error).message}`;
      }
      assertions++;
      if (status !== 401 && status !== 403) wrong.push(`${c.label} -> ${status}`);
    }
    expect(wrong, `${key} did not refuse:\n${wrong.join('\n')}`).toEqual([]);
  }, 60_000);
});
