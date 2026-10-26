// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Who may call each API route handler — the expected answer, written by hand
// from each handler's own gate. test/api-route-role-matrix-pg.test.ts calls
// every handler as every role NOT listed here (and unauthenticated) and
// asserts a 401/403.
//
// Role lists are written out literally, deliberately NOT built from the
// canAccess* helpers in lib/auth/admin-auth.ts: if a helper's role set drifts,
// the routes behind it stop matching this table and the test fails.
//
// Keys are '<path relative to app/api> <METHOD>', the same form as
// test/api-route-authz-coverage.test.ts. Values:
//   - an array of roles  — the ONLY roles the handler admits; every other role
//                          and an unauthenticated caller must get 401/403.
//   - 'NON_SESSION'      — token-authenticated or public by design (the
//                          NON_SESSION_PREFIXES in api-route-authz-coverage).
//                          No session assertions are made.
//   - 'SELF_OR_DATA'     — every signed-in role reaches the handler and the
//                          refusal depends on data (author-or-admin, own
//                          records, department visibility). Only the
//                          unauthenticated caller is asserted.
//   - { roles, query }   — as an array, but the request carries a query string
//                          because the default request would stop at input
//                          validation before the role check (see the note on
//                          the entry).

export type Role = 'admin' | 'viewer' | 'manager' | 'cowork' | 'code' | 'pulse';
export const ALL_ROLES: readonly Role[] = ['admin', 'viewer', 'manager', 'cowork', 'code', 'pulse'];

export type MatrixEntry = readonly Role[] | 'NON_SESSION' | 'SELF_OR_DATA' | { roles: readonly Role[]; query: string };

// Literal role sets (named for readability only — never derived from helpers).
const ADMIN: readonly Role[] = ['admin'];
const ADMIN_MANAGER: readonly Role[] = ['admin', 'manager']; // canAccessPulseAdmin / canAccessAuditLog
const CORE: readonly Role[] = ['admin', 'viewer', 'manager']; // canAccessCorePlatform
const ORG: readonly Role[] = ['admin', 'manager', 'viewer']; // canAccessOrgOverview
const COWORK_PULSE: readonly Role[] = ['admin', 'manager', 'viewer', 'cowork', 'pulse'];
const CODE_PULSE: readonly Role[] = ['admin', 'manager', 'viewer', 'code', 'pulse'];
const EVERY_ROLE: readonly Role[] = ALL_ROLES; // role-dependent payload, no role refused

export const ROUTE_ROLE_MATRIX: Record<string, MatrixEntry> = {
  'access-audit GET': ADMIN,
  'admin/alerts-slack/test POST': ADMIN,
  'admin/clear-data POST': ADMIN,
  'admin/connector-tokens GET': ADMIN,
  'admin/connector-tokens POST': ADMIN,
  'admin/connector-tokens DELETE': ADMIN,
  'admin/digest/preview GET': ADMIN_MANAGER,
  'admin/digest GET': ADMIN,
  'admin/digest PUT': ADMIN,
  'admin/digest/test POST': ADMIN,
  'admin/export GET': ADMIN,
  'admin/files GET': ADMIN,
  'admin/forgot-password POST': 'NON_SESSION',
  'admin/highlights/preview GET': ADMIN,
  'admin/highlights GET': ADMIN,
  'admin/highlights/send POST': ADMIN,
  'admin/identity-conflicts/[id] POST': ADMIN,
  'admin/identity-conflicts GET': ADMIN,
  'admin/login POST': 'NON_SESSION',
  'admin/logout POST': 'NON_SESSION',
  'admin/mfa/disable POST': 'SELF_OR_DATA', // the caller's own MFA
  'admin/mfa/setup GET': 'SELF_OR_DATA',
  'admin/mfa/setup POST': 'SELF_OR_DATA',
  'admin/mfa/verify POST': 'NON_SESSION',
  'admin/otel-prepopulate POST': ADMIN,
  'admin/otel-status GET': ADMIN,
  'admin/pulse/psr-baselines GET': ADMIN,
  'admin/pulse/psr-baselines POST': ADMIN,
  'admin/reset-password POST': 'NON_SESSION',
  'admin/session GET': 'NON_SESSION',
  'admin/sessions GET': ADMIN,
  'admin/sessions DELETE': ADMIN,
  'admin/setup POST': 'NON_SESSION',
  'admin/sso-test POST': ADMIN,
  'admin/subagents GET': ADMIN,
  'admin/system-health GET': ADMIN,
  'admin/users/[id]/reset-mfa POST': ADMIN,
  'admin/users/[id] PATCH': ADMIN,
  'admin/users/[id] DELETE': ADMIN,
  'admin/users GET': ADMIN,
  'admin/users POST': ADMIN,
  'ai/analyze POST': CORE,
  'ai/briefing GET': CORE,
  'ai/report GET': CORE,
  'ai/report POST': CORE,
  'alerts/count GET': CORE,
  'alerts GET': CORE,
  'alerts PATCH': ADMIN,
  'alerts DELETE': ADMIN,
  'anthropic/models GET': ADMIN,
  'archive/config GET': ADMIN,
  'archive/config POST': ADMIN,
  'archive/test POST': ADMIN,
  'audit/session-spend GET': ADMIN_MANAGER,
  'auth/sso/callback GET': 'NON_SESSION',
  'auth/sso/meta GET': 'NON_SESSION',
  'auth/sso/start GET': 'NON_SESSION',
  'chat/messages GET': ADMIN, // gateContentRead adminOnly
  'chat/thread GET': ADMIN_MANAGER, // gateContentRead (canAccessAuditLog) + dept filter
  'config GET': EVERY_ROLE, // non-admins get only NON_ADMIN_CONFIG_KEYS
  'config POST': ADMIN,
  'config/secret DELETE': ADMIN,
  'config/test POST': ADMIN,
  // Default request has no ?sessionId, which is the admin-only session list.
  // With ?sessionId the gate is canAccessAuditLog (admin, manager).
  'cowork/messages GET': ADMIN,
  'dashboard GET': CORE,
  'db/stats GET': ADMIN,
  'errors/log POST': 'NON_SESSION',
  'errors GET': ADMIN,
  'events GET': ADMIN_MANAGER,
  'export/health GET': 'NON_SESSION',
  'export/summary GET': 'NON_SESSION',
  'export/trends GET': 'NON_SESSION',
  'get-started GET': ADMIN,
  'get-started POST': ADMIN,
  'finance/chargeback/close POST': ADMIN,
  'finance/chargeback/export GET': ADMIN_MANAGER,
  'finance/chargeback GET': ADMIN_MANAGER,
  'finance/cost-centres GET': ADMIN,
  'finance/cost-centres POST': ADMIN,
  'finance/model-efficiency GET': ADMIN_MANAGER,
  'finance/trend GET': ADMIN_MANAGER,
  'health GET': 'NON_SESSION',
  // Under the ingest/ NON_SESSION prefix in api-route-authz-coverage, but each
  // of these is requireAdmin, so it is asserted as admin-only here.
  'ingest/analytics POST': ADMIN,
  'ingest/compliance POST': ADMIN,
  'ingest/trigger POST': ADMIN,
  'intent-categories GET': ADMIN,
  'intent-categories POST': ADMIN,
  'library/[id] GET': 'SELF_OR_DATA', // any role; department-restricted entries 404
  'library/[id] DELETE': ADMIN_MANAGER,
  'library/[id] PATCH': 'SELF_OR_DATA', // author or admin/manager
  'library/[id]/vote POST': 'SELF_OR_DATA', // any user may upvote once
  'library GET': 'SELF_OR_DATA', // any role; department visibility filter
  'library POST': 'SELF_OR_DATA', // any user may submit
  'mcp POST': 'NON_SESSION',
  'mcp GET': 'NON_SESSION',
  'otel/ingest POST': 'NON_SESSION',
  'pulse/admin/aggregate POST': ADMIN,
  'pulse/admin/audit GET': ADMIN,
  'pulse/admin/audit POST': ADMIN,
  // Human time spot-check: carries each session's first prompt.
  'pulse/admin/human-time-checks GET': ADMIN,
  'pulse/admin/human-time-checks POST': ADMIN,
  'pulse/admin/classify POST': ADMIN,
  'pulse/admin/health GET': ADMIN,
  'pulse/admin/health POST': ADMIN,
  'pulse/admin/stats GET': ADMIN_MANAGER,
  'pulse/admin/tiers GET': ADMIN,
  'pulse/admin/tiers POST': ADMIN,
  'pulse/admin/users/[userId] GET': ADMIN_MANAGER,
  'pulse/admin/users GET': COWORK_PULSE, // + dept scoping for contributor roles
  'pulse/briefing POST': ADMIN_MANAGER,
  'pulse/capabilities GET': 'SELF_OR_DATA', // non-admins see their own events only
  'pulse/capabilities PATCH': 'SELF_OR_DATA', // non-admins may action their own events only
  'pulse/capability-ledger GET': ADMIN_MANAGER,
  'pulse/cio GET': ORG,
  'pulse/coaching/ack POST': ADMIN_MANAGER,
  'pulse/coaching/ack DELETE': ADMIN_MANAGER,
  'pulse/code/briefing GET': CODE_PULSE,
  'pulse/code/briefing POST': ADMIN_MANAGER,
  'pulse/code/classifier GET': ADMIN_MANAGER,
  'pulse/code/classifier POST': ADMIN,
  'pulse/code/dept/[dept] GET': CODE_PULSE, // + own-department check for contributor roles
  'pulse/code/depts GET': CODE_PULSE,
  'pulse/code/framework GET': ORG,
  'pulse/code/github/identity GET': ADMIN_MANAGER,
  'pulse/code/github/identity POST': ADMIN,
  'pulse/code/github/identity DELETE': ADMIN,
  'pulse/code/github GET': ADMIN_MANAGER,
  'pulse/code/github PUT': ADMIN,
  'pulse/code/github POST': ADMIN,
  'pulse/code/health GET': ADMIN_MANAGER,
  'pulse/code/me GET': CODE_PULSE,
  'pulse/code/org-summary GET': ORG,
  'pulse/code/rates GET': ADMIN_MANAGER,
  'pulse/code/rates PUT': ADMIN,
  'pulse/code/users GET': CODE_PULSE,
  'pulse/code/value GET': ORG,
  'pulse/cowork/aggregate POST': ADMIN,
  'pulse/dept/[dept] GET': COWORK_PULSE, // + own-department check for contributor roles
  'pulse/depts GET': COWORK_PULSE,
  'pulse/governance-health GET': ADMIN_MANAGER,
  'pulse/me GET': COWORK_PULSE,
  'pulse/org-summary GET': ORG,
  'pulse/person/[userId] GET': COWORK_PULSE, // + same-department check for contributor roles
  // Role check now runs before the ?dept/?userId input check (fixed),
  // so the plain request must be refused for roles outside the set.
  'pulse/skill-exchange GET': COWORK_PULSE,
  'pulse/skills-discover GET': COWORK_PULSE,
  'pulse/skills-discover POST': COWORK_PULSE,
  'pulse/skills-overview GET': 'SELF_OR_DATA', // the caller's own skills
  'pulse/stickiness GET': ORG,
  'pulse/team/[teamId] GET': ADMIN,
  'pulse/teams GET': ADMIN,
  'pulse/user-prefs GET': 'SELF_OR_DATA', // own prefs; ?userId only for admin/manager
  'pulse/user-prefs POST': 'SELF_OR_DATA',
  'retention/run POST': ADMIN,
  'finance/spend-review GET': ADMIN_MANAGER,
  'finance/spend-review/[userId] GET': 'SELF_OR_DATA', // admin/manager for anyone; every other role only their own
  'finance/spend-review/[userId]/sessions/[sessionId] GET': ADMIN_MANAGER, // prompt text: gateContentRead
  'support/bundle GET': ADMIN,
  'use-cases/[id]/activate POST': ADMIN_MANAGER,
  'use-cases/[id]/impact-summary POST': ADMIN_MANAGER,
  'use-cases/[id] GET': ADMIN_MANAGER,
  'use-cases/[id] PATCH': ADMIN_MANAGER,
  'use-cases/[id] DELETE': ADMIN_MANAGER,
  'use-cases/[id]/skill-draft GET': ADMIN_MANAGER,
  'use-cases/[id]/skill-draft POST': ADMIN_MANAGER,
  'use-cases/[id]/skill-draft PATCH': ADMIN_MANAGER,
  'use-cases/[id]/skill-draft DELETE': ADMIN_MANAGER,
  'use-cases/[id]/skill-draft/zip GET': ADMIN_MANAGER,
  'use-cases/extract POST': ADMIN_MANAGER,
  'use-cases/governance GET': ORG,
  'use-cases/ideate POST': ADMIN_MANAGER,
  'use-cases GET': ADMIN_MANAGER,
  'use-cases POST': ADMIN_MANAGER,
  'use-cases/suggestions/[id] PATCH': ADMIN_MANAGER,
  'use-cases/suggestions/refresh POST': ADMIN_MANAGER,
  'use-cases/suggestions GET': ADMIN_MANAGER,
  'use-cases/summary GET': ADMIN_MANAGER,
  'users/export GET': ADMIN,
  'users GET': EVERY_ROLE, // payload narrows by role; ?id / ?deactivated are admin only
  'users PUT': ADMIN,
  'users PATCH': ADMIN,
  'users DELETE': ADMIN,
};
