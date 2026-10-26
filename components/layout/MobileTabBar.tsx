// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import NavIcon from './NavIcon';
import { visibleMobileNavItems, type NavFlags } from '@/lib/nav/items';

export default function MobileTabBar() {
  const pathname = usePathname();
  const [role, setRole] = useState('');
  const [flags, setFlags] = useState<NavFlags>({ useCasesEnabled: false, chargebackEnabled: false });
  const [openAlerts, setOpenAlerts] = useState(0);

  useEffect(() => {
    fetch('/api/admin/session')
      .then(r => r.json())
      .then(data => { if (data.authenticated) setRole(data.user?.role ?? ''); })
      .catch(() => {});

    fetch('/api/config')
      .then(r => r.json())
      .then(data => setFlags({
        useCasesEnabled: data.useCasesEnabled === true,
        chargebackEnabled: data.chargebackEnabled === true,
      }))
      .catch(() => {});

    const refreshAlertCount = () => {
      fetch('/api/alerts/count')
        .then(r => (r.ok ? r.json() : Promise.reject()))
        .then(data => { if (typeof data.count === 'number') setOpenAlerts(data.count); })
        .catch(() => {});
    };
    refreshAlertCount();
    window.addEventListener('alertsChanged', refreshAlertCount);
    return () => window.removeEventListener('alertsChanged', refreshAlertCount);
  }, []);

  const items = visibleMobileNavItems(role, flags);
  if (items.length === 0) return null;

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/';
    if (href === '/pulse/cio') {
      return pathname.startsWith('/pulse')
        && !pathname.startsWith('/pulse/code')
        && !pathname.startsWith('/pulse/use-cases');
    }
    return pathname.startsWith(href);
  };

  return (
    <nav
      aria-label="Primary"
      className="lg:hidden fixed bottom-0 inset-x-0 z-30 bg-white border-t border-gray-200 flex pb-[env(safe-area-inset-bottom)]"
    >
      {items.map(item => (
        <Link
          key={item.href}
          href={item.href}
          className={`flex-1 min-w-0 flex flex-col items-center gap-0.5 pt-2 pb-1.5 text-[11px] font-medium ${
            isActive(item.href) ? 'text-brand' : 'text-gray-500'
          }`}
        >
          <span className="relative">
            <NavIcon name={item.icon} />
            {item.href === '/alerts' && openAlerts > 0 && (
              <span className="absolute -top-1 -right-2 inline-flex items-center justify-center min-w-[16px] h-4 px-1 bg-brand text-white text-[9px] font-bold leading-none rounded-full">
                {openAlerts}
              </span>
            )}
          </span>
          <span className="truncate max-w-full px-0.5">{item.label}</span>
        </Link>
      ))}
    </nav>
  );
}
