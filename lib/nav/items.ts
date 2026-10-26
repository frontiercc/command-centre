// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

// Single source of truth for nav-item visibility, consumed by BOTH
// components/layout/Sidebar.tsx and components/layout/MobileTabBar.tsx
// so the two can never drift. Mirrors — never replaces — the server-side
// route/API authorisation.

export type NavFlags = {
  useCasesEnabled: boolean;
  chargebackEnabled: boolean;
};

export type MobileNavItem = {
  href: string;
  label: string;
  icon: string;
};

export function isCorePlatformRole(role: string): boolean {
  return role === 'admin' || role === 'viewer' || role === 'manager';
}

/** Mirrors canAccessAuditLog in lib/auth/admin-auth.ts — viewers excluded. */
export function canSeeAuditLog(role: string): boolean {
  return role === 'admin' || role === 'manager';
}

function isAdminOrManager(role: string): boolean {
  return role === 'admin' || role === 'manager';
}

export function canSeeFinOps(role: string, chargebackEnabled: boolean): boolean {
  return chargebackEnabled && isAdminOrManager(role);
}

export function canSeeCoworkOverview(role: string): boolean {
  return isCorePlatformRole(role);
}

export function canSeeCodeOverview(role: string): boolean {
  return isCorePlatformRole(role);
}

export function canSeeUseCasesOverview(role: string, useCasesEnabled: boolean): boolean {
  return useCasesEnabled && isAdminOrManager(role);
}

export function visibleMobileNavItems(role: string, flags: NavFlags): MobileNavItem[] {
  const items: MobileNavItem[] = [];
  if (isCorePlatformRole(role)) {
    items.push({ href: '/', label: 'Home', icon: 'grid' });
    items.push({ href: '/alerts', label: 'Alerts', icon: 'bell' });
  }
  if (canSeeFinOps(role, flags.chargebackEnabled)) {
    items.push({ href: '/finops', label: 'FinOps', icon: 'currency' });
  }
  if (canSeeCoworkOverview(role)) {
    items.push({ href: '/pulse/cio', label: 'Work', icon: 'pulse' });
  }
  if (canSeeCodeOverview(role)) {
    items.push({ href: '/pulse/code', label: 'Developer', icon: 'code' });
  }
  if (canSeeUseCasesOverview(role, flags.useCasesEnabled)) {
    items.push({ href: '/use-cases', label: 'Use Cases', icon: 'file-text' });
  }
  return items;
}
