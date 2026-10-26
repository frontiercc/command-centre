// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0
// Some icon drawings in this file are from Heroicons (MIT); see THIRD-PARTY-NOTICES.md.

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import NavIcon from './NavIcon';
import { logoFor, type Theme } from '@/lib/theme';
import PrecisionSidebar, { type NavVisibility } from './PrecisionSidebar';
import { isCorePlatformRole, canSeeAuditLog, canSeeFinOps, canSeeUseCasesOverview, canSeeCoworkOverview, canSeeCodeOverview } from '@/lib/nav/items';

const navItems = [
  { href: '/', label: 'Dashboard', icon: 'grid' },
  { href: '/audit', label: 'Audit Log', icon: 'shield' },
  { href: '/alerts', label: 'Alerts', icon: 'bell' },
  { href: '/reports', label: 'Reports', icon: 'file-text' },
  { href: '/library', label: 'S&C Board', icon: 'library' },
  { href: '/pulse', label: 'Work Pulse', icon: 'pulse' },
  { href: '/use-cases', label: 'Use Cases', icon: 'file-text' },
];

const bottomItems = [
  { href: '/admin', label: 'Admin', icon: 'settings' },
];

const NAV_CACHE_KEY = 'ccc-nav-cache';

function saveNavCache(patch: Record<string, unknown>) {
  try {
    const prev = JSON.parse(sessionStorage.getItem(NAV_CACHE_KEY) || '{}');
    sessionStorage.setItem(NAV_CACHE_KEY, JSON.stringify({ ...prev, ...patch }));
  } catch { /* storage unavailable */ }
}

function clearNavCache() {
  try { sessionStorage.removeItem(NAV_CACHE_KEY); } catch { /* storage unavailable */ }
}

export default function Sidebar({ theme = 'default' }: { theme?: Theme }) {
  const pathname = usePathname();
  const [openAlerts, setOpenAlerts] = useState(0);
  const [orgName, setOrgName] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [userRole, setUserRole] = useState('');
  const [pulsePending, setPulsePending] = useState(0);
  const [pulseOpen, setPulseOpen] = useState(false);
  const [codePulseOpen, setCodePulseOpen] = useState(false);
  const [finopsOpen, setFinopsOpen] = useState(false);
  const [useCasesOpen, setUseCasesOpen] = useState(true);
  const [useCasesEnabled, setUseCasesEnabled] = useState(false);
  const [chargebackEnabled, setChargebackEnabled] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');

  const onCodePulse = pathname.startsWith('/pulse/code');

  // Paint the menu from the last known session straight away on a full page load, then let the
  // fetches below confirm it. A per-tab convenience only: the server still gates every page and
  // API, and logout clears it. Read in an effect (not initial state) so hydration matches.
  useEffect(() => {
    try {
      const cached = JSON.parse(sessionStorage.getItem(NAV_CACHE_KEY) || 'null');
      if (cached && typeof cached.role === 'string') {
        setUserRole(cached.role);
        setDisplayName(cached.displayName ?? '');
        setEmail(cached.email ?? '');
        if (cached.orgName) setOrgName(cached.orgName);
        setUseCasesEnabled(cached.useCasesEnabled === true);
        setChargebackEnabled(cached.chargebackEnabled === true);
        if (cached.role === 'admin' || cached.role === 'manager') setIsAdmin(true);
      }
    } catch { /* storage unavailable: fall back to the fetches */ }
  }, []);

  useEffect(() => {
    const refreshAlertCount = () => {
      fetch('/api/alerts/count')
        .then(r => r.ok ? r.json() : Promise.reject())
        .then(data => {
          if (typeof data.count === 'number') setOpenAlerts(data.count);
        })
        .catch(() => {});
    };

    refreshAlertCount();
    window.addEventListener('alertsChanged', refreshAlertCount);
    // Poll every 60 s so AI-generated alerts surface without a page reload
    const pollTimer = setInterval(refreshAlertCount, 60_000);

    fetch('/api/config')
      .then(r => r.json())
      .then(data => {
        if (data.organisationName) setOrgName(data.organisationName);
        setUseCasesEnabled(data.useCasesEnabled === true);
        setChargebackEnabled(data.chargebackEnabled === true);
        saveNavCache({ orgName: data.organisationName ?? '', useCasesEnabled: data.useCasesEnabled === true, chargebackEnabled: data.chargebackEnabled === true });
      })
      .catch(() => {});

    fetch('/api/admin/session')
      .then(r => r.json())
      .then(data => {
        if (data.authenticated) {
          const role = data.user?.role ?? '';
          setUserRole(role);
          setDisplayName(data.user?.displayName ?? '');
          setEmail(data.user?.email ?? '');
          if (role === 'admin' || role === 'manager') setIsAdmin(true);
          saveNavCache({ role, displayName: data.user?.displayName ?? '', email: data.user?.email ?? '' });
        } else {
          clearNavCache();
          // Signed out, or holding a session that no longer exists: go to
          // sign-in, which sends a new installation on to setup.
          const path = window.location.pathname;
          const signInPage = ['/login', '/admin/login', '/admin/setup', '/admin/forgot-password'].includes(path)
            || path.startsWith('/admin/reset-password/');
          if (!signInPage) window.location.replace('/admin/login');
        }
      })
      .catch(() => {});

    return () => {
      window.removeEventListener('alertsChanged', refreshAlertCount);
      clearInterval(pollTimer);
    };
  }, []);

  // Fetch capability queue count once we know the user is admin
  useEffect(() => {
    if (!isAdmin) return;
    fetch('/api/pulse/capabilities')
      .then(r => r.json())
      .then(data => setPulsePending(data.pendingCount ?? 0))
      .catch(() => {});
  }, [isAdmin]);

  // Auto-expand the matching Pulse section — Developer Pulse routes live under
  // /pulse/code; /pulse/use-cases is the Use Cases governance view (its own
  // section), so it must NOT spring open Work Pulse; everything else under
  // /pulse belongs to Work Pulse.
  useEffect(() => {
    if (pathname.startsWith('/finops')) setFinopsOpen(true);
    if (pathname.startsWith('/pulse/code')) setCodePulseOpen(true);
    else if (pathname.startsWith('/pulse/use-cases')) setUseCasesOpen(true);
    else if (pathname.startsWith('/pulse')) setPulseOpen(true);
  }, [pathname]);

  // Auto-expand Pulse for contributor roles and manager on login
  useEffect(() => {
    if (userRole === 'cowork' || userRole === 'pulse' || userRole === 'manager') setPulseOpen(true);
    if (userRole === 'code') setCodePulseOpen(true);
  }, [userRole]);

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/';
    return pathname.startsWith(href);
  };

  const flatNavItems = navItems
    .filter(i => i.href !== '/pulse')
    .filter(i => i.href !== '/use-cases');

  // Sidebar visibility mirrors the real page/API authorization for each flat item,
  // so a role never sees a link it would be 403'd from:
  //   dashboard / alerts / reports → canAccessCorePlatform (admin|viewer|manager)
  //   audit                     → canAccessAuditLog (admin|manager — no viewers)
  //   S&C Board (/library)                  → any authenticated role
  const canSeeFlatNav = (href: string): boolean => {
    const corePlatform = isCorePlatformRole(userRole);
    switch (href) {
      case '/audit':
        return canSeeAuditLog(userRole);
      case '/':
      case '/alerts':
      case '/reports':
        return corePlatform;
      case '/library':
        return userRole !== '';
      default:
        return userRole !== 'cowork';
    }
  };

  // Who may see what. The Precision sidebar reads these; keep them in step with the markup below.
  const vis: NavVisibility = {
    core: isCorePlatformRole(userRole),
    audit: canSeeAuditLog(userRole),
    finops: canSeeFinOps(userRole, chargebackEnabled),
    cowork: userRole === 'admin' || userRole === 'manager' || userRole === 'viewer' || userRole === 'cowork' || userRole === 'pulse',
    coworkOverview: canSeeCoworkOverview(userRole),
    coworkUsers: userRole === 'admin' || userRole === 'manager' || userRole === 'cowork' || userRole === 'pulse' || userRole === 'viewer',
    code: userRole === 'admin' || userRole === 'manager' || userRole === 'viewer' || userRole === 'code' || userRole === 'pulse',
    codeOverview: canSeeCodeOverview(userRole),
    codeTeam: userRole === 'admin' || userRole === 'manager' || userRole === 'viewer' || userRole === 'code' || userRole === 'pulse',
    codeOrg: userRole === 'admin' || userRole === 'manager' || userRole === 'viewer',
    useCases: useCasesEnabled && (userRole === 'admin' || userRole === 'manager' || userRole === 'viewer'),
    useCasesOverview: canSeeUseCasesOverview(userRole, useCasesEnabled),
    library: userRole !== '',
    admin: userRole === 'admin' || userRole === 'manager',
    adminHref: userRole === 'admin' ? '/admin/overview' : '/admin/pulse',
  };

  const logout = async () => {
    clearNavCache();
    await fetch('/api/admin/logout', { method: 'POST' });
    window.location.href = '/login';
  };

  if (theme === 'precision') {
    return (
      <PrecisionSidebar
        pathname={pathname}
        userRole={userRole}
        vis={vis}
        openAlerts={openAlerts}
        pulsePending={pulsePending}
        orgName={orgName}
        displayName={displayName}
        email={email}
        onLogout={logout}
      />
    );
  }

  const subLinkCls = (href: string) =>
    `block px-3 py-1.5 rounded-[12px] text-xs font-medium transition-colors ${
      isActive(href)
        ? 'bg-sidebar-hover text-white'
        : 'text-gray-400 hover:bg-sidebar-hover hover:text-white'
    }`;

  return (
    <aside className="ccc-sidebar w-64 bg-sidebar-bg min-h-screen hidden lg:flex flex-col text-gray-300 fixed left-0 top-0 bottom-0 z-30">
      {/* Brand header */}
      <div className="p-6 pb-4">
        <div className="mb-0.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={logoFor(theme)}
            alt="Frontier Command Centre"
            className="h-8 w-auto"
          />
        </div>
        <p className="text-gray-500 text-sm font-light mt-0.5">Command Centre</p>
      </div>

      {/* Divider */}
      <div className="mx-4 border-t border-gray-800" />

      {/* Main nav */}
      <nav className="flex-1 py-4 px-3">
        {/* Flat items — visibility matches each item's page/API authorization (see canSeeFlatNav) */}
        {flatNavItems.filter(item => canSeeFlatNav(item.href)).map(item => (
          <Link
            key={item.href}
            href={item.href}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-[12px] text-sm font-medium transition-colors mb-0.5 ${
              isActive(item.href)
                ? 'bg-sidebar-hover text-white border-l-2 border-brand'
                : 'hover:bg-sidebar-hover hover:text-white'
            }`}
          >
            <NavIcon name={item.icon} />
            <span>{item.label}</span>
            {item.label === 'Alerts' && openAlerts > 0 && (
              <span className="ml-auto inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 bg-brand text-white text-xs font-bold leading-none rounded-full">
                {openAlerts}
              </span>
            )}
          </Link>
        ))}

        {/* FinOps — expandable; flag-gated, admin|manager only. Spend Review lives under it. */}
        {canSeeFinOps(userRole, chargebackEnabled) && <div className="mb-0.5">
          <button
            onClick={() => setFinopsOpen(o => !o)}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-[12px] text-sm font-medium transition-colors ${
              isActive('/finops')
                ? 'bg-sidebar-hover text-white border-l-2 border-brand'
                : 'hover:bg-sidebar-hover hover:text-white'
            }`}
          >
            <NavIcon name="currency" />
            <span>FinOps</span>
            <span className="ml-auto flex items-center gap-1.5">
              <svg
                className={`w-3 h-3 transition-transform ${finopsOpen ? 'rotate-180' : ''}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </span>
          </button>
          {finopsOpen && (
            <div className="ml-8 mt-0.5 mb-1 space-y-0.5">
              <Link
                href="/finops"
                className={`block px-3 py-1.5 rounded-[12px] text-xs font-medium transition-colors ${
                  pathname === '/finops' ? 'bg-sidebar-hover text-white' : 'text-gray-400 hover:bg-sidebar-hover hover:text-white'
                }`}
              >
                Overview
              </Link>
              <Link href="/finops/spend-review" className={subLinkCls('/finops/spend-review')}>
                Spend Review
              </Link>
            </div>
          )}
        </div>}

        {/* Work Pulse — expandable; hidden for code-only role */}
        {(userRole === 'admin' || userRole === 'manager' || userRole === 'viewer' || userRole === 'cowork' || userRole === 'pulse') && <div className="mb-0.5">
          <button
            onClick={() => setPulseOpen(o => !o)}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-[12px] text-sm font-medium transition-colors ${
              pathname.startsWith('/pulse') && !onCodePulse && !pathname.startsWith('/pulse/use-cases')
                ? 'bg-sidebar-hover text-white border-l-2 border-brand'
                : 'hover:bg-sidebar-hover hover:text-white'
            }`}
          >
            <NavIcon name="pulse" />
            <span>Work Pulse</span>
            <span className="ml-auto flex items-center gap-1.5">
              {pulsePending > 0 && (
                <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 bg-brand text-white text-xs font-bold leading-none rounded-full">
                  {pulsePending}
                </span>
              )}
              <svg
                className={`w-3 h-3 transition-transform ${pulseOpen ? 'rotate-180' : ''}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </span>
          </button>
          {pulseOpen && (
            <div className="ml-8 mt-0.5 mb-1 space-y-0.5">
              {canSeeCoworkOverview(userRole) && (
                <Link href="/pulse/cio" className={subLinkCls('/pulse/cio')}>
                  Overview
                </Link>
              )}
              <Link href="/pulse/me" className={subLinkCls('/pulse/me')}>
                My Pulse
              </Link>
              {(userRole === 'admin' || userRole === 'manager' || userRole === 'cowork' || userRole === 'pulse' || userRole === 'viewer') && (
                <Link href="/pulse/users" className={subLinkCls('/pulse/users')}>
                  Users
                </Link>
              )}
              <Link href="/pulse/dept" className={subLinkCls('/pulse/dept')}>
                Departments
              </Link>
              <Link href="/pulse/skills" className={subLinkCls('/pulse/skills')}>
                Tool usage
              </Link>
            </div>
          )}
        </div>}

        {/* Developer Pulse — expandable; hidden for cowork-only role */}
        {(userRole === 'admin' || userRole === 'manager' || userRole === 'viewer' || userRole === 'code' || userRole === 'pulse') && <div className="mb-0.5">
          <button
            onClick={() => setCodePulseOpen(o => !o)}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-[12px] text-sm font-medium transition-colors ${
              onCodePulse
                ? 'bg-sidebar-hover text-white border-l-2 border-brand'
                : 'hover:bg-sidebar-hover hover:text-white'
            }`}
          >
            <NavIcon name="code" />
            <span>Developer Pulse</span>
            <span className="ml-auto flex items-center gap-1.5">
              <svg
                className={`w-3 h-3 transition-transform ${codePulseOpen ? 'rotate-180' : ''}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </span>
          </button>
          {codePulseOpen && (
            <div className="ml-8 mt-0.5 mb-1 space-y-0.5">
              {canSeeCodeOverview(userRole) && (
                <Link
                  href="/pulse/code"
                  className={`block px-3 py-1.5 rounded-[12px] text-xs font-medium transition-colors ${
                    pathname === '/pulse/code'
                      ? 'bg-sidebar-hover text-white'
                      : 'text-gray-400 hover:bg-sidebar-hover hover:text-white'
                  }`}
                >
                  Overview
                </Link>
              )}
              <Link href="/pulse/code/me" className={subLinkCls('/pulse/code/me')}>
                My Developer Pulse
              </Link>
              {(userRole === 'admin' || userRole === 'manager' || userRole === 'viewer' || userRole === 'code' || userRole === 'pulse') && (
                <Link href="/pulse/code/users" className={subLinkCls('/pulse/code/users')}>
                  Users
                </Link>
              )}
              {(userRole === 'admin' || userRole === 'manager' || userRole === 'viewer' || userRole === 'code' || userRole === 'pulse') && (
                <Link href="/pulse/code/dept" className={subLinkCls('/pulse/code/dept')}>
                  Departments
                </Link>
              )}
              {(userRole === 'admin' || userRole === 'manager' || userRole === 'viewer') && (
                <Link href="/pulse/code/framework" className={subLinkCls('/pulse/code/framework')}>
                  Dev Framework Alignment
                </Link>
              )}
              {(userRole === 'admin' || userRole === 'manager' || userRole === 'viewer') && (
                <Link href="/pulse/code/value" className={subLinkCls('/pulse/code/value')}>
                  Value
                </Link>
              )}
            </div>
          )}
        </div>}

        {/* Use Cases — expandable; Register (admin/manager) + Governance (admin/manager/viewer) */}
        {useCasesEnabled && (userRole === 'admin' || userRole === 'manager' || userRole === 'viewer') && (
          <div className="mb-0.5">
            <button
              onClick={() => setUseCasesOpen(o => !o)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-[12px] text-sm font-medium transition-colors ${
                (pathname.startsWith('/use-cases') || pathname.startsWith('/pulse/use-cases'))
                  ? 'bg-sidebar-hover text-white border-l-2 border-brand'
                  : 'hover:bg-sidebar-hover hover:text-white'
              }`}
            >
              <NavIcon name="file-text" />
              <span>Use Cases</span>
              <span className="ml-auto">
                <svg className={`w-3 h-3 transition-transform ${useCasesOpen ? 'rotate-180' : ''}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </span>
            </button>
            {useCasesOpen && (
              <div className="ml-8 mt-0.5 mb-1 space-y-0.5">
                {canSeeUseCasesOverview(userRole, useCasesEnabled) && (
                  <Link href="/use-cases" className={subLinkCls('/use-cases')}>Overview</Link>
                )}
                {(userRole === 'admin' || userRole === 'manager' || userRole === 'viewer') && (
                  <Link href="/pulse/use-cases" className={subLinkCls('/pulse/use-cases')}>Use Case Governance</Link>
                )}
              </div>
            )}
          </div>
        )}
      </nav>

      {/* Divider */}
      <div className="mx-4 border-t border-gray-800" />

      {/* Bottom nav */}
      <div className="py-3 px-3">
        {(userRole === 'admin' || userRole === 'manager') && bottomItems.map(item => (
          <Link
            key={item.href}
            href={item.href}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-[12px] text-sm font-medium transition-colors ${
              isActive(item.href)
                ? 'bg-sidebar-hover text-white border-l-2 border-brand'
                : 'hover:bg-sidebar-hover hover:text-white'
            }`}
          >
            <NavIcon name={item.icon} />
            <span>{item.label}</span>
          </Link>
        ))}
        <button
          onClick={async () => {
            clearNavCache();
            await fetch('/api/admin/logout', { method: 'POST' });
            window.location.href = '/login';
          }}
          className="flex items-center gap-3 px-3 py-2.5 rounded-[12px] text-sm font-medium transition-colors hover:bg-sidebar-hover hover:text-white w-full mt-1"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
          </svg>
          <span>Logout</span>
        </button>
      </div>

      {/* Org name footer */}
      {orgName && (
        <div className="px-6 py-3 border-t border-gray-800">
          <p className="text-gray-500 text-xs truncate">{orgName}</p>
        </div>
      )}
    </aside>
  );
}
