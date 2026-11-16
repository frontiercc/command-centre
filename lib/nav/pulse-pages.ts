// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Where to send someone who types the address of a Pulse page the menu does not give them, so they
// land on their own page rather than one that cannot load. Mirrors the menu in
// components/layout/Sidebar.tsx. This only moves the person on: every API still decides what they see.

const WORK_ROLES = new Set(['admin', 'manager', 'viewer', 'cowork', 'pulse']);
const CODE_ROLES = new Set(['admin', 'manager', 'viewer', 'code', 'pulse']);
const OVERVIEW_ROLES = new Set(['admin', 'manager', 'viewer']);

/** The organisation-wide pages, which the menu gives admins, managers and viewers only. */
const WORK_OVERVIEWS = ['/pulse/cio'];
const CODE_OVERVIEWS = ['/pulse/code', '/pulse/code/cio', '/pulse/code/framework', '/pulse/code/value'];

const under = (path: string, base: string) => path === base || path.startsWith(base + '/');

/** The page to send this role to from this path, or null to let the page open. */
export function pulsePageRedirect(role: string, path: string): string | null {
  if (!WORK_ROLES.has(role) && !CODE_ROLES.has(role)) return null; // not signed in yet, or a role this does not cover
  if (path === '/pulse' || under(path, '/pulse/use-cases')) return null; // the index sends people on itself; Use Cases is its own menu group
  if (!under(path, '/pulse')) return null;

  if (under(path, '/pulse/code')) {
    if (!CODE_ROLES.has(role)) return '/pulse/me';
    if (CODE_OVERVIEWS.some(p => under(path, p) && (p !== '/pulse/code' || path === p)) && !OVERVIEW_ROLES.has(role)) return '/pulse/code/me';
    return null;
  }
  if (!WORK_ROLES.has(role)) return '/pulse/code/me';
  if (WORK_OVERVIEWS.some(p => under(path, p)) && !OVERVIEW_ROLES.has(role)) return '/pulse/me';
  return null;
}
