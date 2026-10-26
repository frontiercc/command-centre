// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0
// Some icon drawings in this file are from Feather (MIT) and Lucide (ISC); see THIRD-PARTY-NOTICES.md.

'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { logoFor } from '@/lib/theme';

/**
 * The Precision theme's sidebar: grouped (Productivity / Spend / Governance), light, with a
 * jump-to-page search (Ctrl/Cmd K). Rendered by Sidebar.tsx, which owns the data fetching;
 * every visibility rule below mirrors Sidebar.tsx so a role never sees a link it would be
 * refused from.
 */
/** Which links this person may see. Computed by Sidebar.tsx with the same rules as its own markup. */
export interface NavVisibility {
  core: boolean;          // Dashboard, Alerts, Reports
  audit: boolean;
  finops: boolean;
  cowork: boolean;
  coworkOverview: boolean;
  coworkUsers: boolean;
  code: boolean;
  codeOverview: boolean;
  codeTeam: boolean;      // Developer Pulse Users and Departments
  codeOrg: boolean;       // Dev Framework Alignment, Value
  useCases: boolean;
  useCasesOverview: boolean;
  library: boolean;
  admin: boolean;
  adminHref: string;
}

export interface PrecisionSidebarProps {
  pathname: string;
  userRole: string;
  vis: NavVisibility;
  openAlerts: number;
  pulsePending: number;
  orgName: string;
  displayName: string;
  email: string;
  onLogout: () => void;
}

interface Item { href: string; label: string; exact?: boolean }
interface Group { key: string; label: string; icon: IconName; href?: string; items?: Item[]; badge?: number; activeWhen: (p: string) => boolean }
type IconName = 'grid' | 'bell' | 'pulse' | 'code' | 'target' | 'layers' | 'currency' | 'shield' | 'file' | 'settings';

const ICONS: Record<IconName, React.ReactNode> = {
  grid: <><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></>,
  bell: <><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></>,
  pulse: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  code: <><path d="m16 18 6-6-6-6" /><path d="m8 6-6 6 6 6" /></>,
  target: <><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /></>,
  layers: <><path d="M12 2 2 7l10 5 10-5-10-5z" /><path d="m2 17 10 5 10-5" /><path d="m2 12 10 5 10-5" /></>,
  currency: <path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />,
  shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></>,
};

function Icon({ name }: { name: IconName }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

function initialsOf(name: string, email: string): string {
  const src = name.trim() || email.trim();
  if (!src) return '';
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

const ROLE_LABEL: Record<string, string> = {
  admin: 'Admin', manager: 'Manager', viewer: 'Viewer', pulse: 'Member', cowork: 'Member', code: 'Member', demo: 'Demo',
};

export default function PrecisionSidebar(p: PrecisionSidebarProps) {
  const { pathname, userRole: role, vis } = p;

  const top: Group[] = [];
  if (vis.core) top.push({ key: 'dash', label: 'Dashboard', icon: 'grid', href: '/', activeWhen: x => x === '/' });
  if (vis.core) top.push({ key: 'alerts', label: 'Alerts', icon: 'bell', href: '/alerts', badge: p.openAlerts, activeWhen: x => x.startsWith('/alerts') });

  const productivity: Group[] = [];
  if (vis.cowork) {
    const items: Item[] = [];
    if (vis.coworkOverview) items.push({ href: '/pulse/cio', label: 'Overview' });
    items.push({ href: '/pulse/me', label: 'My Pulse' });
    if (vis.coworkUsers) items.push({ href: '/pulse/users', label: 'Users' });
    items.push({ href: '/pulse/dept', label: 'Departments' });
    items.push({ href: '/pulse/skills', label: 'Tool usage' });
    productivity.push({ key: 'cowork', label: 'Work Pulse', icon: 'pulse', items, badge: p.pulsePending,
      activeWhen: x => x.startsWith('/pulse') && !x.startsWith('/pulse/code') && !x.startsWith('/pulse/use-cases') });
  }
  if (vis.code) {
    const items: Item[] = [];
    if (vis.codeOverview) items.push({ href: '/pulse/code', label: 'Overview', exact: true });
    items.push({ href: '/pulse/code/me', label: 'My Developer Pulse' });
    if (vis.codeTeam) {
      items.push({ href: '/pulse/code/users', label: 'Users' });
      items.push({ href: '/pulse/code/dept', label: 'Departments' });
    }
    if (vis.codeOrg) {
      items.push({ href: '/pulse/code/framework', label: 'Dev Framework Alignment' });
      items.push({ href: '/pulse/code/value', label: 'Value' });
    }
    productivity.push({ key: 'code', label: 'Developer Pulse', icon: 'code', items, activeWhen: x => x.startsWith('/pulse/code') });
  }
  if (vis.useCases) {
    const items: Item[] = [];
    if (vis.useCasesOverview) items.push({ href: '/use-cases', label: 'Overview' });
    items.push({ href: '/pulse/use-cases', label: 'Governance' });
    productivity.push({ key: 'usecases', label: 'Use Cases', icon: 'target', items,
      activeWhen: x => x.startsWith('/use-cases') || x.startsWith('/pulse/use-cases') });
  }
  if (vis.library) productivity.push({ key: 'library', label: 'S&C Board', icon: 'layers', href: '/library', activeWhen: x => x.startsWith('/library') });

  const spend: Group[] = [];
  if (vis.finops) {
    spend.push({ key: 'finops', label: 'FinOps', icon: 'currency', activeWhen: x => x.startsWith('/finops'),
      items: [{ href: '/finops', label: 'Overview', exact: true }, { href: '/finops/spend-review', label: 'Spend Review' }] });
  }

  const governance: Group[] = [];
  if (vis.audit) governance.push({ key: 'audit', label: 'Audit Log', icon: 'shield', href: '/audit', activeWhen: x => x.startsWith('/audit') });
  if (vis.core) governance.push({ key: 'reports', label: 'Reports', icon: 'file', href: '/reports', activeWhen: x => x.startsWith('/reports') });

  const sections: { label: string | null; groups: Group[] }[] = [
    { label: null, groups: top },
    { label: 'Productivity', groups: productivity },
    { label: 'Spend', groups: spend },
    { label: 'Governance', groups: governance },
  ].filter(s => s.groups.length > 0);

  // Groups open when the current page is inside them; the person can toggle any group.
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const isOpen = (g: Group) => open[g.key] ?? g.activeWhen(pathname);
  const itemActive = (it: Item) => (it.exact ? pathname === it.href : pathname === it.href || pathname.startsWith(it.href + '/'));

  // Destinations for the jump-to-page search: every visible page, labelled with its section.
  const destinations = useMemo(() => {
    const out: { href: string; label: string }[] = [];
    for (const s of sections) for (const g of s.groups) {
      if (g.href) out.push({ href: g.href, label: g.label });
      for (const it of g.items ?? []) out.push({ href: it.href, label: `${g.label} · ${it.label}` });
    }
    if (vis.admin) out.push({ href: vis.adminHref, label: 'Admin' });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vis]);

  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen(o => !o); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <aside className="ccc-psidebar hidden lg:flex" aria-label="Main navigation">
      <div className="ccc-psb-brand">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logoFor('precision')} alt="Frontier Command Centre" />
        {p.orgName && <span className="ccc-psb-org">{p.orgName}</span>}
      </div>
      {/* No visible search box; Ctrl/Cmd K still opens jump-to-page. */}
      <nav className="ccc-psb-nav">
        {sections.map(s => (
          <div key={s.label ?? 'top'} className="ccc-psb-section">
            {s.label && <div className="ccc-psb-label">{s.label}</div>}
            {s.groups.map(g => {
              const active = g.activeWhen(pathname);
              if (g.href) {
                return (
                  <Link key={g.key} href={g.href} className={`ccc-psb-link${active ? ' is-active' : ''}`} aria-current={active ? 'page' : undefined}>
                    <Icon name={g.icon} /><span>{g.label}</span>
                    {!!g.badge && g.badge > 0 && <span className="ccc-psb-badge">{g.badge}</span>}
                  </Link>
                );
              }
              const o = isOpen(g);
              return (
                <div key={g.key}>
                  <button type="button" className={`ccc-psb-link${active ? ' is-parent' : ''}`} aria-expanded={o}
                    onClick={() => setOpen(prev => ({ ...prev, [g.key]: !o }))}>
                    <Icon name={g.icon} /><span>{g.label}</span>
                    {!!g.badge && g.badge > 0 && <span className="ccc-psb-badge">{g.badge}</span>}
                    <svg className="ccc-psb-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                      <path d={o ? 'm6 9 6 6 6-6' : 'm9 6 6 6-6 6'} />
                    </svg>
                  </button>
                  {o && (
                    <div className="ccc-psb-sub">
                      {(g.items ?? []).map(it => {
                        const a = itemActive(it);
                        return (
                          <Link key={it.href} href={it.href} className={`ccc-psb-sublink${a ? ' is-active' : ''}`} aria-current={a ? 'page' : undefined}>
                            {it.label}
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="ccc-psb-foot">
        {vis.admin && (
          <Link href={vis.adminHref} className={`ccc-psb-link${pathname.startsWith('/admin') ? ' is-active' : ''}`}>
            <Icon name="settings" /><span>Admin</span>
          </Link>
        )}
        <div className="ccc-psb-user">
          <span className="ccc-psb-avatar">{initialsOf(p.displayName, p.email)}</span>
          <span className="ccc-psb-who">
            <span className="ccc-psb-name">{p.displayName || p.email}</span>
            <span className="ccc-psb-role">{ROLE_LABEL[role] ?? role}</span>
          </span>
          <button type="button" className="ccc-psb-logout" aria-label="Log out" onClick={p.onLogout}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></svg>
          </button>
        </div>
      </div>

      {searchOpen && <JumpTo destinations={destinations} onClose={() => setSearchOpen(false)} />}
    </aside>
  );
}

function JumpTo({ destinations, onClose }: { destinations: { href: string; label: string }[]; onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const matches = destinations.filter(d => d.label.toLowerCase().includes(q.trim().toLowerCase()));
  const go = (href: string) => { onClose(); router.push(href); };

  return (
    <div className="ccc-jump-backdrop" onClick={onClose}>
      <div className="ccc-jump" role="dialog" aria-modal="true" aria-label="Jump to a page" onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={q}
          placeholder="Jump to a page"
          aria-label="Jump to a page"
          onChange={e => { setQ(e.target.value); setSel(0); }}
          onKeyDown={e => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, matches.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); }
            else if (e.key === 'Enter' && matches[sel]) go(matches[sel].href);
          }}
        />
        <ul>
          {matches.length === 0 && <li className="ccc-jump-empty">No page matches</li>}
          {matches.map((m, i) => (
            <li key={m.href}>
              <button type="button" className={i === sel ? 'is-sel' : ''} onMouseEnter={() => setSel(i)} onClick={() => go(m.href)}>{m.label}</button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
