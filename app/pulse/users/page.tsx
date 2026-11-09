// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import StatStrip from '@/components/pulse/StatStrip';
import JourneyGrid from '@/components/pulse/JourneyGrid';
import FrontierHero from '@/components/pulse/FrontierHero';
import type { FrontierView } from '@/lib/pulse/frontier-view';
import MilestoneCards from '@/components/pulse/MilestoneCards';
import type { ToolUsed } from '@/components/pulse/MilestoneCards';
import GenerateBriefingButton from '@/components/pulse/GenerateBriefingButton';
import WeeklyPulse from '@/components/pulse/WeeklyPulse';
import HumanTimeCard, { type HumanTimeSummary } from '@/components/pulse/HumanTimeCard';
import { PageBody, Toolbar, Notice, B, cx } from '@/components/precision/ui';
import { useVendor, useOpenAiOnly, VendorSwitch } from '@/components/shared/VendorSwitch';
import { WORK_PULSE_VENDOR_LABELS } from '@/lib/dashboard/vendor';

interface PersonalPulseData {
  humanTime?: HumanTimeSummary | null;
  userId: string | null;
  displayName: string | null;
  department: string | null;
  metrics: { oti: number | null; dds: number | null; psr: number | null; ors: number | null } | null;
  priorMetrics: { oti: number | null; dds: number | null; psr: number | null; ors: number | null } | null;
  frontier: FrontierView | null;
  frontierAccess?: { canReview: boolean; canOpenUseCases: boolean };
  journeyGrid: Array<{ week: number; tier: number; count: number }>;
  toolsUsed: ToolUsed[];
  weeklyPulse: { body: string; suggestion: string | null; generated_at: number } | null;
  capabilitiesDetail: { count: number } | null;
  teamMetrics: { ors: number | null } | null;
  openaiPresent?: boolean;
}

interface UserListRow {
  id: string;
  display_name: string | null;
  email: string;
  department: string | null;
  dds: number | null;
}

export default function UsersPickerPage() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [adminChecked, setAdminChecked] = useState(false);
  const [userRole, setUserRole] = useState('');
  const deptScoped = userRole === 'cowork' || userRole === 'pulse';
  const [userDept, setUserDept] = useState<string | null>(null);
  const [users, setUsers] = useState<UserListRow[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [pulseData, setPulseData] = useState<PersonalPulseData | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedUserId = searchParams.get('userId') ?? '';
  // The All / Claude / ChatGPT switch, the same remembered choice as My Pulse.
  const [vendor, setVendor, vendorReady] = useVendor();
  const openaiOnly = useOpenAiOnly();

  // Admin gate
  useEffect(() => {
    fetch('/api/admin/session')
      .then(r => r.json())
      .then(data => {
        if (!data.authenticated) { router.replace('/pulse/me'); return; }
        const role = data.user?.role ?? '';
        // Admins and managers see everyone; cowork and pulse roles see their own
        // department, the rule both routes this page reads already apply.
        if (role !== 'admin' && role !== 'manager' && role !== 'cowork' && role !== 'pulse') {
          router.replace('/pulse/me');
          return;
        }
        setUserRole(role);
        setUserDept(data.user?.department ?? null);
        setAdminChecked(true);
      })
      .catch(() => router.replace('/pulse/me'));
  }, [router]);

  // Load user list
  useEffect(() => {
    if (!adminChecked) return;
    if (deptScoped && !userDept) { setUsersLoading(false); return; }
    const url = deptScoped && userDept
      ? `/api/pulse/admin/users?dept=${encodeURIComponent(userDept)}`
      : '/api/pulse/admin/users';
    fetch(url)
      .then(r => r.json())
      .then(d => {
        const list: UserListRow[] = d.users ?? [];
        setUsers(list);
        if (!searchParams.get('userId') && list.length > 0) {
          const params = new URLSearchParams(searchParams.toString());
          params.set('userId', list[0].id);
          router.replace(`/pulse/users?${params.toString()}`);
        }
      })
      .catch(() => {})
      .finally(() => setUsersLoading(false));
  }, [adminChecked, deptScoped, userDept]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadUser = useCallback((userId: string) => {
    if (!userId) return;
    setDataLoading(true);
    setError(null);
    fetch(`/api/pulse/me?userId=${encodeURIComponent(userId)}&vendor=${vendor}`)
      .then(r => {
        if (!r.ok) throw new Error("Couldn't load this page. Try again.");
        return r.json();
      })
      .then(setPulseData)
      .catch(e => setError(e.message))
      .finally(() => setDataLoading(false));
  }, [vendor]);

  useEffect(() => {
    // The saved view is read after the page loads; wait for it so one view loads, not two.
    if (selectedUserId && adminChecked && vendorReady) loadUser(selectedUserId);
  }, [selectedUserId, adminChecked, vendorReady, loadUser]);

  const handleSelect = (userId: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('userId', userId);
    router.push(`/pulse/users?${params.toString()}`);
  };

  if (!adminChecked) return (
    <>
      <TopBar title="Users" subtitle="Per-user delegation pulse" />
      <LoadingSpinner />
    </>
  );

  if (adminChecked && deptScoped && !userDept) {
    return (
      <>
        <TopBar title="Users" subtitle="Per-user delegation pulse" />
        <PageBody>
          <Notice tone="warn" title="No department assigned.">
            Your account doesn&apos;t have a department set yet. Ask your admin to assign you to a department so you can see your team&apos;s Pulse data.
          </Notice>
        </PageBody>
      </>
    );
  }

  const selectedUser = users.find(u => u.id === selectedUserId);
  const displayName = selectedUser?.display_name ?? selectedUser?.email ?? '';

  return (
    <>
      <TopBar
        title="Users"
        subtitle={displayName ? `Delegation pulse · ${displayName}` : 'Select a user'}
      />
      <PageBody>

        {/* User picker (top-left), as on Developer Pulse → Users */}
        <Toolbar
          left={
            <span className="flex items-center gap-3 flex-wrap">
              {usersLoading ? (
                <span className="block h-8 w-64 bg-[#F2F2F2] rounded-[10px] animate-pulse" />
              ) : (
                <select
                  aria-label="Person"
                  value={selectedUserId}
                  onChange={e => handleSelect(e.target.value)}
                  className={cx(B.select, 'min-w-[240px] text-[14px]')}
                >
                  {users.length === 0 && (
                    <option value="">No users with Pulse data</option>
                  )}
                  {users.map(u => (
                    <option key={u.id} value={u.id}>
                      {u.display_name ?? u.email}
                      {u.department ? ` · ${u.department}` : ''}
                      {u.dds != null ? ` (depth ${u.dds.toFixed(2)})` : ''}
                    </option>
                  ))}
                </select>
              )}
              {selectedUserId && (
                <Link href={`/pulse/person/${encodeURIComponent(selectedUserId)}`} className={B.link}>
                  Person 360
                </Link>
              )}
              {selectedUserId && userRole === 'admin' && (
                <Link href={`/admin/pulse/users/${selectedUserId}`} className={B.link}>
                  Full admin view
                </Link>
              )}
              {selectedUser?.department && <span>{selectedUser.department}</span>}
            </span>
          }
        >
          <VendorSwitch vendor={vendor} onChange={setVendor} openaiPresent={pulseData?.openaiPresent ?? false} labels={WORK_PULSE_VENDOR_LABELS} />
        </Toolbar>
        {vendor !== 'all' && !openaiOnly && (
          <p className="m-0 -mt-2 text-[13px] text-[#8F8F8F]">
            Showing {WORK_PULSE_VENDOR_LABELS[vendor]} only{vendor === 'openai' ? ': ChatGPT Chat and ChatGPT Work' : ': Claude Chat, Claude Cowork and Claude in Office/Google'}.
          </p>
        )}

        {dataLoading && <LoadingSpinner />}
        {error && <Notice tone="error" title="Failed to load.">{error}</Notice>}

        {pulseData && !dataLoading && (() => {
          const d = pulseData;
          const m = d.metrics;
          const pm = d.priorMetrics;
          const delta = (curr: number | null, prior: number | null) =>
            pm ? (curr !== null && prior !== null ? Math.round((curr - prior) * 100) / 100 : null) : undefined;

          return (
            <>
              <FrontierHero view={d.frontier} canOpenUseCases={d.frontierAccess?.canOpenUseCases ?? false} />

              <HumanTimeCard summary={d.humanTime} surface="cowork" scope="Personal" view={d.openaiPresent ? vendor : 'claude'} />

              <StatStrip
                oti={m?.oti ?? null} dds={m?.dds ?? null}
                psr={d.capabilitiesDetail?.count ?? m?.psr ?? null}
                ors={d.teamMetrics?.ors ?? m?.ors ?? null}
                hideOrs
                otiDelta={delta(m?.oti ?? null, pm?.oti ?? null)}
                ddsDelta={delta(m?.dds ?? null, pm?.dds ?? null)}
                psrDelta={delta(m?.psr ?? null, pm?.psr ?? null)}
                orsDelta={delta(m?.ors ?? null, pm?.ors ?? null)}
                />

              <JourneyGrid data={d.journeyGrid} />

              <MilestoneCards frontier={d.frontier} canReview={d.frontierAccess?.canReview ?? false} canOpenUseCases={d.frontierAccess?.canOpenUseCases ?? false} toolsUsed={d.toolsUsed ?? []} />

              <WeeklyPulse
                briefing={d.weeklyPulse}
                userId={d.userId ?? undefined}
                onGenerate={() => loadUser(selectedUserId)}
                action={d.weeklyPulse && d.userId ? (
                  <GenerateBriefingButton
                    type="user"
                    userId={d.userId}
                    onComplete={() => loadUser(selectedUserId)}
                  />
                ) : undefined}
              />
            </>
          );
        })()}

      </PageBody>
    </>
  );
}
