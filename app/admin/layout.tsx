// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';

const adminNavItems = [
  { href: '/admin/overview', label: 'Overview' },
  { href: '/admin/users', label: 'User Insights' },
  { href: '/admin/ingestion', label: 'Ingestion' },
  { href: '/admin/security', label: 'Access & Keys' },
  { href: '/admin/risk', label: 'Risk Scoring' },
  { href: '/admin/subagents', label: 'Claude Sub Agents' },
  { href: '/admin/intent', label: 'Intent Detection' },
  { href: '/admin/pulse', label: 'Work Pulse' },
  { href: '/admin/code-pulse', label: 'Developer Pulse' },
  { href: '/admin/use-cases', label: 'Use Cases' },
  { href: '/admin/cost-centres', label: 'Cost Centres' },
  { href: '/admin/compliance', label: 'Compliance' },
  { href: '/admin/access-audit', label: 'Access Audit' },
  { href: '/admin/files', label: 'Files' },
  { href: '/admin/data', label: 'Data' },
  { href: '/admin/system', label: 'System' },
];

const authPages = ['/admin/login', '/admin/setup'];

interface AdminUser {
  username: string;
  role: string;
}

function usePulsePendingCount() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    fetch('/api/pulse/capabilities')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => setCount(d.pendingCount ?? 0))
      .catch(() => {});
  }, []);
  return count;
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);
  const pulsePendingCount = usePulsePendingCount();

  const isAuthPage = authPages.some(p => pathname === p || pathname.startsWith(p + '/'));

  useEffect(() => {
    if (isAuthPage) {
      setLoading(false);
      return;
    }

    fetch('/api/admin/session')
      .then(r => r.json())
      .then(data => {
        if (data.setupNeeded) {
          router.push('/admin/setup');
        } else if (!data.authenticated) {
          router.push(`/admin/login?from=${encodeURIComponent(pathname)}`);
        } else if (data.user?.role !== 'admin') {
          const role = data.user?.role;
          if (role === 'manager' && pathname.startsWith('/admin/pulse')) {
            // Manager is allowed at /admin/pulse only
            setUser({ username: data.user.email, role });
            setLoading(false);
          } else {
            setAccessDenied(true);
            setLoading(false);
            setTimeout(() => router.replace('/pulse/me'), 2500);
          }
        } else {
          setUser({ username: data.user.email, role: data.user.role });
          setLoading(false);
        }
      })
      .catch(() => {
        router.push(`/admin/login?from=${encodeURIComponent(pathname)}`);
      });
  }, [pathname, isAuthPage, router]);

  // Auth pages render without admin chrome
  if (isAuthPage) {
    return <>{children}</>;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen text-[#8F8F8F] text-[14px]">
        Loading...
      </div>
    );
  }

  if (accessDenied) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center max-w-sm px-6">
          <div className="w-10 h-10 rounded-full bg-[#FFF1E0] flex items-center justify-center mx-auto mb-4">
            <svg className="w-5 h-5 text-[#B54708]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
          </div>
          <h2 className="m-0 mb-1.5 text-[#0A0A0A] text-[16px] font-semibold">Admin access required</h2>
          <p className="m-0 mb-1 text-[#666666] text-[14px]">You don&apos;t have permission to access the admin area.</p>
          <p className="m-0 text-[#8F8F8F] text-[13px]">Redirecting you to your Pulse&hellip;</p>
        </div>
      </div>
    );
  }

  // Not authenticated and not on auth page — redirect in progress
  if (!user) {
    return null;
  }

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(href + '/');

  return (
    <div className="flex min-h-screen">
      {/* Admin sub-navigation sidebar: a light settings panel, deliberately
          distinct from the dark main sidebar so the two do not read as one
          over-wide block. */}
      <aside className="w-[196px] bg-white border-r border-[#EAEAEA] flex flex-col flex-shrink-0" aria-label="Admin">
        <div className="px-4 pt-4 pb-2">
          <h2 className="m-0 text-[12px] font-medium text-[#8F8F8F]">Admin</h2>
        </div>

        <nav className="flex-1 px-2 pb-4 flex flex-col gap-px">
          {adminNavItems
            .filter(item => user.role === 'admin' || item.href === '/admin/pulse')
            .map(item => (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center justify-between px-2 py-[5px] rounded-[10px] text-[14px] ${
                isActive(item.href)
                  ? 'bg-[#EDEDED] text-[#0A0A0A] font-medium'
                  : 'text-[#4D4D4D] hover:bg-[#F0F0F0] hover:text-[#0A0A0A]'
              }`}
            >
              <span>{item.label}</span>
              {item.href === '/admin/pulse' && pulsePendingCount > 0 && (
                <span className="text-[12px] font-semibold bg-[#245BF3] text-white px-1.5 rounded-full min-w-[18px] h-[18px] inline-flex items-center justify-center tabular-nums">
                  {pulsePendingCount}
                </span>
              )}
            </Link>
          ))}
        </nav>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
}
