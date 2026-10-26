// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

/**
 * Breadcrumb trail for the Precision theme's page header (components/layout/TopBar.tsx).
 * Client-safe and pure. The last crumb is the page's own name; when a page has a dynamic
 * name (a person, a department), the trail ends at its section and TopBar appends the
 * page's title.
 */
export interface Crumbs {
  /** Section crumbs, in order. */
  trail: string[];
  /** The page's short name, shown as the last crumb and the page heading. Null = use the page title. */
  page: string | null;
}

const EXACT: Record<string, Crumbs> = {
  '/': { trail: [], page: 'Dashboard' },
  '/alerts': { trail: [], page: 'Alerts' },
  '/audit': { trail: [], page: 'Audit Log' },
  '/reports': { trail: [], page: 'Reports' },
  '/users': { trail: [], page: 'Users' },
  '/library': { trail: [], page: 'S&C Board' },
  '/library/submit': { trail: ['S&C Board'], page: 'Submit a skill' },
  '/finops': { trail: ['FinOps'], page: 'Overview' },
  '/finops/spend-review': { trail: ['FinOps'], page: 'Spend Review' },
  '/pulse/cio': { trail: ['Work Pulse'], page: 'Overview' },
  '/pulse/me': { trail: ['Work Pulse'], page: 'My Pulse' },
  '/pulse/users': { trail: ['Work Pulse'], page: 'Users' },
  '/pulse/dept': { trail: ['Work Pulse'], page: 'Departments' },
  '/pulse/skills': { trail: ['Work Pulse'], page: 'Tool usage' },
  '/pulse/code': { trail: ['Developer Pulse'], page: 'Overview' },
  '/pulse/code/me': { trail: ['Developer Pulse'], page: 'My Developer Pulse' },
  '/pulse/code/users': { trail: ['Developer Pulse'], page: 'Users' },
  '/pulse/code/dept': { trail: ['Developer Pulse'], page: 'Departments' },
  '/pulse/code/framework': { trail: ['Developer Pulse'], page: 'Dev Framework Alignment' },
  '/pulse/code/value': { trail: ['Developer Pulse'], page: 'Value' },
  '/pulse/use-cases': { trail: ['Use Cases'], page: 'Governance' },
  '/use-cases': { trail: ['Use Cases'], page: 'Overview' },
  '/use-cases/new': { trail: ['Use Cases'], page: 'Add use case' },
  '/use-cases/ideate': { trail: ['Use Cases'], page: 'Ideate' },
  '/use-cases/import': { trail: ['Use Cases'], page: 'Import transcript' },
};

const PREFIX: [string, string[]][] = [
  ['/finops/spend-review/', ['FinOps', 'Spend Review']],
  ['/library/', ['S&C Board']],
  ['/pulse/code/', ['Developer Pulse']],
  ['/pulse/user/', ['Work Pulse', 'Users']],
  ['/pulse/person/', ['Work Pulse', 'Person 360']],
  ['/pulse/dept/', ['Work Pulse', 'Departments']],
  ['/pulse/', ['Work Pulse']],
  ['/use-cases/', ['Use Cases']],
  ['/users/', ['Users']],
  ['/admin/', ['Admin']],
];

export function crumbsFor(pathname: string): Crumbs {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (EXACT[path]) return EXACT[path];
  for (const [prefix, trail] of PREFIX) {
    if (path.startsWith(prefix)) return { trail, page: null };
  }
  return { trail: [], page: null };
}

/** A page title with its section prefix removed: "Work Pulse admin" under Admin reads "Work Pulse". */
export function shortTitle(title: string, trail: string[]): string {
  let t = title;
  for (const crumb of trail) {
    if (t.startsWith(`${crumb} — `)) t = t.slice(crumb.length + 3);
    else if (t.startsWith(`${crumb}: `)) t = t.slice(crumb.length + 2);
  }
  return t.replace(/ (?:— Admin|admin)$/, '');
}
