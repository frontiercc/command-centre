// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import FrontierHero from '@/components/pulse/FrontierHero';
import type { FrontierView } from '@/lib/pulse/frontier-view';
import GenerateBriefingButton from '@/components/pulse/GenerateBriefingButton';
import { cleanTitle } from '@/components/pulse/CapabilityLog';
import { Frame } from '@/components/pulse/WorkPulseOverview';
import {
  WorkPanel, TaskList, DeeperPanel, ByHandPanel, ProducedPanel, ColleagueToolsPanel, SpendPanel,
  EmptyPeriodPanels, SpendFailed,
  type ByHand, type MonthSpend, type Who, type DrillKind,
} from '@/components/pulse/MyPulsePanels';
import type { MyPeriod, PulsePeriod } from '@/lib/pulse/period-shape';
import type { TierNames } from '@/lib/pulse/tier-names';
import { PageBody, Toolbar, Notice, B, cx, Muted } from '@/components/precision/ui';
import { useVendor, useOpenAiOnly, VendorSwitch } from '@/components/shared/VendorSwitch';
import { WORK_PULSE_VENDOR_LABELS } from '@/lib/dashboard/vendor';
import { withTierNames } from '@/lib/pulse/tier-names';
import { sharedGet } from '@/components/shared/shared-get';
import { sortByLabel } from '@/lib/ui/alphabetical';

interface PersonalPulseData {
  /** Parts of the response that failed to build, so their panels say so. */
  failed?: string[];
  humanTime?: ByHand | null;
  period?: MyPeriod | null;
  tierNames?: TierNames | null;
  spendThisMonth?: MonthSpend | null;
  canSeeSpendReview?: boolean;
  userId: string | null;
  displayName: string | null;
  department: string | null;
  frontier: FrontierView | null;
  frontierAccess?: { canReview: boolean; canOpenUseCases: boolean };
  weeklyPulse: { body: string; suggestion: string | null; generated_at: number } | null;
  capabilitiesDetail: {
    count: number;
    pending?: Array<{ id: number; title: string; body: string | null; detected_at: number }>;
  } | null;
  openaiPresent?: boolean;
}

interface UserListRow {
  id: string;
  display_name: string | null;
  email: string;
  department: string | null;
  tier_1_count: number | null;
  tier_2_count: number | null;
  tier_3_count: number | null;
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
  // One period for the page, as on My Pulse.
  const [period, setPeriod] = useState<PulsePeriod>('quarter');
  const [drill, setDrill] = useState<DrillKind | null>(null);

  const selectedUserId = searchParams.get('userId') ?? '';
  // The All / Claude / ChatGPT switch, the same remembered choice as My Pulse.
  const [vendor, setVendor, vendorReady] = useVendor();
  const openaiOnly = useOpenAiOnly();

  // Admin gate
  useEffect(() => {
    sharedGet('/api/admin/session')
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

  // Load user list. Asked for straight away, alongside the sign-in check rather than after it: the
  // route itself limits a department-scoped role to its own department and refuses anyone else.
  useEffect(() => {
    if (!vendorReady) return; // the saved view is read after the page loads
    // The depth beside each name follows the switch.
    fetch(`/api/pulse/admin/users?vendor=${vendor}`)
      .then(r => r.json())
      .then(d => {
        const list: UserListRow[] = d.users ?? [];
        setUsers(list);
        if (!searchParams.get('userId') && list.length > 0) {
          const params = new URLSearchParams(searchParams.toString());
          params.set('userId', sortByLabel(list, u => u.display_name ?? u.email)[0].id);
          router.replace(`/pulse/users?${params.toString()}`);
        }
      })
      .catch(() => {})
      .finally(() => setUsersLoading(false));
  }, [vendor, vendorReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadUser = useCallback((userId: string, fresh = false) => {
    if (!userId) return;
    setDataLoading(true);
    setError(null);
    // `fresh` after an action on the page, so it shows the change, not the kept figures.
    fetch(`/api/pulse/me?userId=${encodeURIComponent(userId)}&vendor=${vendor}&period=${period}${fresh ? '&fresh=1' : ''}`)
      .then(r => {
        if (!r.ok) throw new Error("Couldn't load this page. Try again.");
        return r.json();
      })
      .then(setPulseData)
      .catch(e => setError(e.message))
      .finally(() => setDataLoading(false));
  }, [vendor, period]);

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
      <TopBar title="Users" subtitle="What each person hands to AI and what it produces" />
      <LoadingSpinner />
    </>
  );

  if (adminChecked && deptScoped && !userDept) {
    return (
      <>
        <TopBar title="Users" subtitle="What each person hands to AI and what it produces" />
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
        subtitle={displayName ? `What ${displayName} hands to AI and what it produces` : 'Select a user'}
      />
      <PageBody className="dash-compact">

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
                  className={cx(B.select, 'w-full max-w-full sm:w-auto sm:min-w-[240px] text-[14px]')}
                >
                  {users.length === 0 && (
                    <option value="">No users with Pulse data</option>
                  )}
                  {sortByLabel(users, u => u.display_name ?? u.email).map(u => (
                    <option key={u.id} value={u.id}>
                      {u.display_name ?? u.email}
                      {u.department ? ` · ${u.department}` : ''}
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
          const who: Who = { you: false, name: d.displayName ?? 'This person' };
          const q = d.period ?? null;
          const pending = d.capabilitiesDetail?.pending ?? [];
          const product = vendor === 'openai' ? 'ChatGPT' : vendor === 'claude' || !d.openaiPresent ? 'Claude' : 'Claude and ChatGPT';
          const reviewHref = d.canSeeSpendReview && d.userId ? `/finops/spend-review/${encodeURIComponent(d.userId)}` : null;

          return (
            <>
              {q ? (
                <>
                  {/* 1. Their work, over the chosen period */}
                  <WorkPanel
                    q={q}
                    product={product}
                    who={who}
                    period={period}
                    onPeriod={setPeriod}
                    onDrill={setDrill}
                    drill={drill}
                    reviewHref={pending.length > 0 ? '#to-review' : null}
                    names={d.tierNames ?? undefined}
                  />

                  {/* The work behind whichever figure was clicked */}
                  {drill && (
                    <TaskList kind={drill} period={period} userId={selectedUserId} who={who} onClose={() => setDrill(null)} names={d.tierNames ?? undefined} vendor={vendor} tool={product === 'Claude and ChatGPT' ? 'AI' : product} />
                  )}

                  {/* 2. Best work this week */}
                  <FrontierHero view={d.frontier} canOpenUseCases={d.frontierAccess?.canOpenUseCases ?? false} names={d.tierNames ?? undefined} />

                  {/* 3. Is their work getting deeper? */}
                  <DeeperPanel q={q} who={who} names={d.tierNames ?? undefined} />

                  {/* 4. By hand vs with Claude */}
                  <ByHandPanel h={d.humanTime} who={who} onSeeSessions={() => setDrill('humantime')} tool={product === 'Claude and ChatGPT' ? 'AI' : product} surface="cowork" />

                  {/* 5 and 6 */}
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
                    <ProducedPanel q={q} who={who} period={period} />
                    <ColleagueToolsPanel q={q} who={who} department={d.department} period={period} />
                  </div>

                  {/* 7 */}
                  {d.spendThisMonth
                    ? <SpendPanel s={d.spendThisMonth} product={product} who={who} reviewHref={reviewHref} />
                    : (d.failed ?? []).includes('spend') ? <SpendFailed who={who} /> : null}
                </>
              ) : (
                // No work yet, or it failed to load: every panel keeps its place and says which.
                <>
                  <EmptyPeriodPanels who={who} failed={(d.failed ?? []).includes('period')} />
                  <FrontierHero view={d.frontier} canOpenUseCases={d.frontierAccess?.canOpenUseCases ?? false} names={d.tierNames ?? undefined} />
                  <ByHandPanel h={d.humanTime} who={who} tool={product === 'Claude and ChatGPT' ? 'AI' : product} surface="cowork" />
                  {d.spendThisMonth
                    ? <SpendPanel s={d.spendThisMonth} product={product} who={who} reviewHref={reviewHref} />
                    : (d.failed ?? []).includes('spend') ? <SpendFailed who={who} /> : null}
                </>
              )}

              {/* 8. Their week, in a paragraph */}
              <Frame
                title={`${who.name}'s week, in a paragraph`}
                tag="AI summary"
                period={
                  <span className="inline-flex items-center gap-2">
                    {d.weeklyPulse && new Date(d.weeklyPulse.generated_at * 1000).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
                    {d.userId && <GenerateBriefingButton type="user" userId={d.userId} onComplete={() => loadUser(selectedUserId, true)} />}
                  </span>
                }
              >
                {d.weeklyPulse ? (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-2 text-[14px] leading-[22px] text-[#1A1A1A]">
                    <div>{d.weeklyPulse.body.split(/\n\s*\n/).filter(t => t.trim()).map((t, i) => <p key={i} className="m-0 mb-2 last:mb-0">{t}</p>)}</div>
                    {d.weeklyPulse.suggestion && <p className="m-0"><b className="font-semibold">Suggestion for next week:</b> {d.weeklyPulse.suggestion}</p>}
                  </div>
                ) : (
                  <p className="m-0 mt-2 text-[13px] text-[#8F8F8F]">No paragraph yet. It is written each Sunday{d.userId ? ', or use Generate now' : ''}.</p>
                )}
              </Frame>

              {/* New ways of working waiting for review */}
              {pending.length === 0 ? <Frame id="to-review" title="Waiting for review"><Muted>Nothing waiting for review.</Muted></Frame> : (
                <Frame id="to-review" title="Waiting for review" period={`${pending.length} new ${pending.length === 1 ? 'way' : 'ways'} of working`}
                  answer={<>Claude thinks {who.name} may have started {pending.length === 1 ? 'a new way of working' : 'new ways of working'}.</>}>
                  {pending.map(c => (
                    <div key={c.id} className="py-2 border-b border-[#F2F2F2] last:border-b-0">
                      <p className="m-0 text-[13px] font-medium text-[#0A0A0A]">{cleanTitle(c.title)}</p>
                      {c.body && <p className="m-0 mt-0.5 text-[12px] text-[#8F8F8F] line-clamp-1">{withTierNames(c.body, d.tierNames)}</p>}
                    </div>
                  ))}
                </Frame>
              )}
            </>
          );
        })()}

      </PageBody>
    </>
  );
}
