// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Drift lock for API authorisation. Signing in to CCC is all it takes to call
// any API route, so "is this person logged in?" is NOT an authorisation check:
// every enrolled Claude user can sign in (role 'pulse'). In September 2026 a
// review found the Audit Log's content routes, the user list, the config and
// the access audit log answering any signed-in user because each route had to
// remember its own role check and several didn't.
//
// This test reads every route handler and fails when one has no role gate and
// is not on an explicit, reasoned allowlist below. A new route therefore fails
// CI until someone decides who may call it — the route fails closed in review
// instead of open in production.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const API_ROOT = path.join(__dirname, '..', 'app', 'api');

// A handler that calls any of these has made an explicit role decision.
const GATE_RE = /\b(requireAdmin|requirePulseAdmin|canAccess\w+|isDeptScoped|gateContentRead|isAdmin|gate|requireRole)\s*\(|\bsession\.role\b|\.session\.role\b|\bg\.session\b/;

// Routes that never use a user session at all: token-authenticated machine
// endpoints, public-by-design auth flows, and the liveness check. Matched by
// route-path prefix (relative to app/api, forward slashes).
const NON_SESSION_PREFIXES: Array<[string, string]> = [
  ['otel/', 'OTLP ingest — collector bearer token'],
  ['export/', 'Metrics Connector — connector bearer token, org aggregates only'],
  ['mcp', 'Metrics Connector MCP — connector bearer token'],
  ['auth/sso/', 'OIDC login flow — public by design'],
  ['health', 'liveness check — public by design, no data'],
  ['admin/login', 'login'],
  ['admin/logout', 'logout — clears the caller\'s own session'],
  ['admin/forgot-password', 'password reset request — public by design'],
  ['admin/reset-password', 'password reset — single-use emailed token'],
  ['admin/setup', 'first-run setup — only while no admin exists'],
  ['admin/session', 'returns the caller\'s own session'],
  ['admin/mfa/verify', 'MFA step of login'],
  ['errors/log', 'client error beacon — write-only, public by design'],
];

// Session routes whose data is the caller's OWN, so any signed-in user may
// call them. Reviewed individually; add a line only with a reason.
const SELF_SCOPED: Record<string, string> = {
  'admin/mfa/setup GET': 'the caller\'s own MFA enrolment',
  'admin/mfa/setup POST': 'the caller\'s own MFA enrolment',
  'admin/mfa/disable POST': 'the caller\'s own MFA',
  'pulse/user-prefs GET': 'the caller\'s own preferences',
  'pulse/skills-overview GET': 'the caller\'s own skills (resolved from session email)',
  'library POST': 'any user may submit a Board entry',
  'library/[id]/vote POST': 'any user may upvote a Board entry once',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === 'route.ts') out.push(p);
  }
  return out;
}

function handlers(src: string): Array<{ method: string; body: string }> {
  const parts = src.split(/export async function (GET|POST|PUT|PATCH|DELETE)\b/);
  const out: Array<{ method: string; body: string }> = [];
  for (let i = 1; i < parts.length; i += 2) out.push({ method: parts[i], body: parts[i + 1] });
  return out;
}

describe('every API route handler makes an explicit authorisation decision', () => {
  const files = walk(API_ROOT);

  it('finds the route files', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('has a role gate, or is token/public/self-scoped with a stated reason', () => {
    const missing: string[] = [];
    for (const f of files) {
      const rel = path.relative(API_ROOT, path.dirname(f)).split(path.sep).join('/');
      if (NON_SESSION_PREFIXES.some(([prefix]) => rel === prefix.replace(/\/$/, '') || rel.startsWith(prefix))) continue;
      const src = fs.readFileSync(f, 'utf8');
      for (const h of handlers(src)) {
        const key = `${rel} ${h.method}`;
        if (SELF_SCOPED[key]) continue;
        if (!GATE_RE.test(h.body)) missing.push(key);
      }
    }
    expect(missing, `Routes with no role gate — add one, or list them above with a reason:\n${missing.join('\n')}`).toEqual([]);
  });

  it('allowlist entries still exist (no stale exemptions)', () => {
    const present = new Set<string>();
    for (const f of files) {
      const rel = path.relative(API_ROOT, path.dirname(f)).split(path.sep).join('/');
      for (const h of handlers(fs.readFileSync(f, 'utf8'))) present.add(`${rel} ${h.method}`);
    }
    for (const key of Object.keys(SELF_SCOPED)) expect(present.has(key), key).toBe(true);
  });
});
