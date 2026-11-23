// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Suspense, useEffect, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import CodeStatStrip, { type CodeMetricsRow, formatTokens, formatCurrency } from '@/components/pulse/code/CodeStatStrip';
import ModelMixBar, { type ModelMixItem } from '@/components/pulse/code/ModelMixBar';
import { DepthPanel, ByHandPanel, type ByHand, type Who } from '@/components/pulse/MyPulsePanels';
import {
  CodeWorkPanel, CodeBestWork, CodeWorkMix,
  type CodePeriodWork, type CodeWorkMixRow, type BestSession,
} from '@/components/pulse/code/CodePulsePanels';
import type { PulsePeriod } from '@/lib/pulse/period-shape';
import type { TierNames } from '@/lib/pulse/tier-names';
import { PageBody, Toolbar, Panel, Tag, Empty, Muted, Notice, B, cx, LOAD_FAILED } from '@/components/precision/ui';
import { useVendor, useOpenAiOnly, VendorSwitch } from '@/components/shared/VendorSwitch';
import { DEVELOPER_PULSE_VENDOR_LABELS, type Vendor } from '@/lib/dashboard/vendor';
import { useSessionRole } from '@/components/shared/useSessionRole';
import { sortByLabel } from '@/lib/ui/alphabetical';

interface SessionRow {
  session_id: string;
  repo: string | null;
  git_branch: string | null;
  first_at: number;
  /** Measured active time in seconds; null when not measured. */
  active_secs?: number | string | null;
  last_at: number;
  user_msg_count: number;
  assistant_turns: number;
  tool_use_count: number;
  input_tokens: number;
  output_tokens: number;
  spend_usd: number | null;
  source: string;
}

interface UserData {
  /** Set when the viewer may not see this person's spend (a colleague): no spend figure is sent. */
  spendHidden?: boolean;
  periodWork?: CodePeriodWork | null;
  tierWeeks?: Array<{ weekStart: number; t1: number; t2: number; t3: number }>;
  tierGrid?: Array<{ weekStart: number; t1: number; t2: number; t3: number }>;
  tierNames?: TierNames | null;
  workMix?: CodeWorkMixRow[];
  bestSession?: BestSession | null;
  vendor?: Vendor;
  codexPresent?: boolean;
  metricsSplit?: { claude: CodeMetricsRow | null; openai: CodeMetricsRow | null } | null;
  userId: string | null;
  displayName: string | null;
  metrics: CodeMetricsRow | null;
  sessions: SessionRow[];
  modelMix: ModelMixItem[];
  journeyGrid: Array<{ week: number; tier: number; count: number }>;
  githubRepos: { count30d: number; names30d: string[] } | null;
  humanTime?: ByHand | null;
}

interface UserListRow {
  user_id: string;
  display_name: string | null;
  email: string | null;
  department: string | null;
  /** 'claude_code' and/or 'codex', once Codex data exists. */
  products?: string[];
}

/**
 * How long a session was worked on: its measured active time (gaps of 30 minutes or less), never
 * the time it stayed open. With no active time measured, the dates it spanned.
 */
function sessionLength(s: { first_at: number; last_at: number; active_secs?: number | string | null }): string {
  if (s.active_secs !== null && s.active_secs !== undefined) {
    const mins = Math.round(Number(s.active_secs) / 60);
    if (mins < 1) return 'under 1m active';
    if (mins < 60) return `${mins}m active`;
    return `${Math.floor(mins / 60).toLocaleString('en-GB')}h ${mins % 60}m active`;
  }
  const a = formatDate(s.first_at), b = formatDate(s.last_at);
  return a === b ? a : `${a} to ${b}`;
}

function formatDate(epoch: number): string {
  return new Date(epoch * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function CodeUsersContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [users, setUsers] = useState<UserListRow[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [data, setData] = useState<UserData | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataFailed, setDataFailed] = useState(false);
  // One period for the page, as on Work Pulse.
  const [period, setPeriod] = useState<PulsePeriod>('quarter');

  const [vendor, setVendor, vendorReady] = useVendor();
  const [codexPresent, setCodexPresent] = useState(false);
  const openaiOnly = useOpenAiOnly();
  const codexView = codexPresent || openaiOnly;

  // As on Work Pulse Users: a viewer cannot open another person's page (the API returns their own),
  // so they go to their own.
  const role = useSessionRole();
  useEffect(() => { if (role === 'viewer') router.replace('/pulse/code/me'); }, [role, router]);

  const selectedUserId = searchParams.get('userId') ?? '';
  // What the switch's view covers, for the empty states.
  const viewLabel = vendor === 'openai' ? 'Codex' : codexView && vendor === 'all' ? 'coding' : 'Claude Code';
  // A person missing from the picker has no activity in this view; their
  // page is not shown, so no figure from another view stands under the name.
  const notInView = !usersLoading && selectedUserId !== '' && !users.some(u => u.user_id === selectedUserId);

  // Load the user list for the dropdown
  useEffect(() => {
    if (!vendorReady) return; // the saved view is read after the page loads
    fetch(`/api/pulse/code/users?vendor=${vendor}`)
      .then(r => r.json())
      .then(d => {
        setCodexPresent(!!d.codexPresent);
        const list: UserListRow[] = (d.users ?? []).map((u: UserListRow) => ({
          user_id: u.user_id, display_name: u.display_name, email: u.email, department: u.department, products: u.products,
        }));
        setUsers(list);
        // Default to the first user (highest spend) when none selected
        if (!searchParams.get('userId') && list.length > 0) {
          const params = new URLSearchParams(searchParams.toString());
          params.set('userId', sortByLabel(list, u => u.display_name ?? u.email ?? '')[0].user_id);
          router.replace(`/pulse/code/users?${params.toString()}`);
        }
      })
      .catch(() => {})
      .finally(() => setUsersLoading(false));
  }, [vendor, vendorReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadUser = useCallback((userId: string) => {
    if (!vendorReady) return; // the saved view is read after the page loads
    if (!userId) return;
    setDataLoading(true);
    setDataFailed(false);
    fetch(`/api/pulse/code/me?userId=${encodeURIComponent(userId)}&vendor=${vendor}&period=${period}`)
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(setData)
      .catch(() => { setData(null); setDataFailed(true); })
      .finally(() => setDataLoading(false));
  }, [vendor, vendorReady, period]);

  useEffect(() => {
    if (selectedUserId) loadUser(selectedUserId);
  }, [selectedUserId, loadUser]);

  const handleSelect = (userId: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('userId', userId);
    router.push(`/pulse/code/users?${params.toString()}`);
  };

  const selectedUser = users.find(u => u.user_id === selectedUserId);
  const displayName = selectedUser?.display_name ?? selectedUser?.email ?? '';

  const who: Who = { you: false, name: data?.displayName ?? 'This person' };

  return (
    <>
      <TopBar
        title="Developer Pulse: Users"
        subtitle={displayName ? `Per-user ${openaiOnly ? 'Codex' : codexPresent ? 'coding' : 'Claude Code'} activity · ${displayName}` : 'Select a user'}
      />
      <PageBody className="dash-compact">
        {/* User picker (top-left) */}
        <Toolbar
          left={
            <span className="flex items-center gap-3 flex-wrap">
              {usersLoading ? (
                <span className="block h-8 w-64 bg-[#F2F2F2] rounded-[10px] animate-pulse" />
              ) : (
                <select
                  aria-label="User"
                  value={selectedUserId}
                  onChange={e => handleSelect(e.target.value)}
                  className={cx(B.select, 'w-full max-w-full sm:w-auto sm:min-w-[240px] text-[14px]')}
                >
                  {users.length === 0 && !notInView && <option value="">No users with {viewLabel} activity</option>}
                  {notInView && <option value={selectedUserId}>{data?.displayName ?? 'This person'} · no {viewLabel} activity</option>}
                  {sortByLabel(users, u => u.display_name ?? u.email ?? '').map(u => (
                    <option key={u.user_id} value={u.user_id}>
                      {u.display_name ?? u.email}{u.department ? ` · ${u.department}` : ''}
                      {codexPresent && !openaiOnly && (u.products?.length ?? 0) > 0 ? ` · ${u.products!.map(p => p === 'codex' ? 'Codex' : 'Claude Code').join(', ')}` : ''}
                    </option>
                  ))}
                </select>
              )}
              {/* Person 360 is a Work Pulse page: the Developer Pulse role cannot open it. */}
              {selectedUserId && role !== '' && role !== 'code' && (
                <Link href={`/pulse/person/${encodeURIComponent(selectedUserId)}`} className={B.link}>
                  Person 360
                </Link>
              )}
            </span>
          }
        >
          <VendorSwitch vendor={vendor} onChange={setVendor} openaiPresent={codexPresent} labels={DEVELOPER_PULSE_VENDOR_LABELS} />
        </Toolbar>

        {dataLoading && <LoadingSpinner />}

        {!dataLoading && notInView && (
          <Empty title={`No ${viewLabel} activity for this person`}>
            {users.length > 0 ? 'Choose someone from the list, or switch view.' : 'Switch view to see other activity.'}
          </Empty>
        )}

        {!dataLoading && !notInView && dataFailed && (
          <Notice tone="error" title="Couldn’t load this person.">Try refreshing the page.</Notice>
        )}

        {!dataLoading && !notInView && data && (
          !data.userId ? (
            <Empty title={openaiOnly ? 'No Codex activity for this user yet' : codexPresent ? 'No coding activity for this user yet' : 'No Claude Code activity for this user yet'}>
              Activity appears after the next hourly aggregation.
            </Empty>
          ) : (
            <>
              {data.periodWork ? (
                <CodeWorkPanel
                  w={data.periodWork}
                  who={who}
                  period={period}
                  onPeriod={setPeriod}
                  product={openaiOnly ? 'Codex' : codexPresent && vendor === 'all' ? 'Claude Code and Codex' : vendor === 'openai' ? 'Codex' : 'Claude Code'}
                />
              ) : <Panel title={`${who.name}'s coding work`}><Muted>{LOAD_FAILED}</Muted></Panel>}

              <CodeBestWork s={data.bestSession ?? null} who={who} names={data.tierNames ?? undefined} />

              {(data.tierGrid?.length ?? 0) > 0 && (
                <DepthPanel
                  weeks={data.tierWeeks ?? []}
                  grid={data.tierGrid ?? []}
                  end={Math.floor(Date.now() / 1000)}
                  names={data.tierNames ?? undefined}
                  title={`Is ${who.name}'s work getting deeper?`}
                  subject={`${who.name} ran`}
                  whose={`${who.name}'s`}
                  unit="session"
                />
              )}

              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <CodeWorkMix rows={data.workMix ?? []} who={who} names={data.tierNames ?? undefined} />
                <ByHandPanel h={data.humanTime} who={who} tool={openaiOnly || vendor === 'openai' ? 'Codex' : codexPresent && vendor === 'all' ? 'AI' : 'Claude Code'} />
              </div>

              <CodeStatStrip metrics={data.metrics} githubRepos={data.githubRepos} view={codexView ? vendor : 'claude'} split={data.metricsSplit} spendHidden={data.spendHidden === true} />

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <ModelMixBar items={data.modelMix} title="Model mix" />
                <Panel title="Recent sessions" flush>
                  {data.sessions.length === 0 ? (
                    <div className="p-4"><Muted>No sessions rolled up yet. Check back after the next hourly cycle.</Muted></div>
                  ) : (
                    <ul className="m-0 p-0 list-none">
                      {data.sessions.slice(0, 10).map(s => (
                        <li key={s.session_id} className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-[#F2F2F2] first:border-t-0">
                          <div className="min-w-0">
                            <span className="block truncate text-[14px] font-medium text-[#0A0A0A]">
                              {s.repo ?? formatDate(s.last_at)}
                              {s.repo && s.git_branch && s.git_branch !== 'HEAD' && (
                                <span className="text-[#8F8F8F] font-normal"> · {s.git_branch}</span>
                              )}
                            </span>
                            <span className="block text-[13px] text-[#8F8F8F] tabular-nums">
                              {s.repo ? `${formatDate(s.last_at)} · ` : ''}{sessionLength(s)} · {s.user_msg_count.toLocaleString('en-GB')} prompts · {s.tool_use_count.toLocaleString('en-GB')} actions
                            </span>
                          </div>
                          <div className="shrink-0 text-right flex flex-col items-end gap-0.5">
                            <span className="text-[14px] font-medium text-[#0A0A0A] tabular-nums">
                              {data.spendHidden ? 'hidden' : s.spend_usd === null ? (s.input_tokens + s.output_tokens === 0 ? 'not measured' : 'not priced') : formatCurrency(s.spend_usd)}
                            </span>
                            <span className="text-[13px] text-[#8F8F8F] tabular-nums">{formatTokens(s.input_tokens + s.output_tokens)} tokens</span>
                            {s.source === 'codex' && <Tag>Codex</Tag>}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>
              </div>
            </>
          )
        )}
      </PageBody>
    </>
  );
}

export default function CodePulseUsersPage() {
  return (
    <Suspense fallback={<LoadingSpinner />}>
      <CodeUsersContent />
    </Suspense>
  );
}
