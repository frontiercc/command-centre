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
import JourneyGrid from '@/components/pulse/JourneyGrid';
import HumanTimeCard, { type HumanTimeSummary } from '@/components/pulse/HumanTimeCard';
import { PageBody, Toolbar, Panel, Tag, Empty, Muted, B, cx } from '@/components/precision/ui';

interface SessionRow {
  session_id: string;
  repo: string | null;
  git_branch: string | null;
  first_at: number;
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
  userId: string | null;
  displayName: string | null;
  metrics: CodeMetricsRow | null;
  sessions: SessionRow[];
  modelMix: ModelMixItem[];
  journeyGrid: Array<{ week: number; tier: number; count: number }>;
  githubRepos: { count7d: number; names7d: string[] } | null;
  humanTime?: HumanTimeSummary | null;
}

interface UserListRow {
  user_id: string;
  display_name: string | null;
  email: string | null;
  department: string | null;
}

function formatDuration(first: number, last: number): string {
  const mins = Math.max(1, Math.round((last - first) / 60));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function formatDate(epoch: number): string {
  return new Date(epoch * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function CodeUsersContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [users, setUsers] = useState<UserListRow[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [data, setData] = useState<UserData | null>(null);
  const [dataLoading, setDataLoading] = useState(false);

  const selectedUserId = searchParams.get('userId') ?? '';

  // Load the user list for the dropdown
  useEffect(() => {
    fetch('/api/pulse/code/users')
      .then(r => r.json())
      .then(d => {
        const list: UserListRow[] = (d.users ?? []).map((u: UserListRow) => ({
          user_id: u.user_id, display_name: u.display_name, email: u.email, department: u.department,
        }));
        setUsers(list);
        // Default to the first user (highest spend) when none selected
        if (!searchParams.get('userId') && list.length > 0) {
          const params = new URLSearchParams(searchParams.toString());
          params.set('userId', list[0].user_id);
          router.replace(`/pulse/code/users?${params.toString()}`);
        }
      })
      .catch(() => {})
      .finally(() => setUsersLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadUser = useCallback((userId: string) => {
    if (!userId) return;
    setDataLoading(true);
    fetch(`/api/pulse/code/me?userId=${encodeURIComponent(userId)}`)
      .then(r => r.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setDataLoading(false));
  }, []);

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

  return (
    <>
      <TopBar
        title="Developer Pulse: Users"
        subtitle={displayName ? `Per-user Claude Code activity · ${displayName}` : 'Select a user'}
      />
      <PageBody>
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
                  className={cx(B.select, 'min-w-[240px] text-[14px]')}
                >
                  {users.length === 0 && <option value="">No users with Code activity</option>}
                  {users.map(u => (
                    <option key={u.user_id} value={u.user_id}>
                      {u.display_name ?? u.email}{u.department ? ` · ${u.department}` : ''}
                    </option>
                  ))}
                </select>
              )}
              {selectedUserId && (
                <Link href={`/pulse/person/${encodeURIComponent(selectedUserId)}`} className={B.link}>
                  Person 360
                </Link>
              )}
            </span>
          }
        />

        {dataLoading && <LoadingSpinner />}

        {!dataLoading && data && (
          !data.userId ? (
            <Empty title="No Claude Code activity for this user yet">
              Activity appears after the next hourly aggregation.
            </Empty>
          ) : (
            <>
              <CodeStatStrip metrics={data.metrics} githubRepos={data.githubRepos} />

              <HumanTimeCard summary={data.humanTime} surface="code" scope="Personal" />

              {(data.journeyGrid?.length ?? 0) > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Tag tone="judged">AI-judged</Tag>
                    <span className="text-[13px] text-[#8F8F8F]">Delegation journey, 6 weeks</span>
                  </div>
                  <JourneyGrid data={data.journeyGrid} />
                </div>
              )}

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
                              {s.repo ? `${formatDate(s.last_at)} · ` : ''}{formatDuration(s.first_at, s.last_at)} · {s.user_msg_count} prompts · {s.tool_use_count} actions
                            </span>
                          </div>
                          <div className="shrink-0 text-right flex flex-col items-end gap-0.5">
                            <span className="text-[14px] font-medium text-[#0A0A0A] tabular-nums">
                              {s.spend_usd === null ? '—' : formatCurrency(s.spend_usd)}
                            </span>
                            <span className="text-[13px] text-[#8F8F8F] tabular-nums">{formatTokens(s.input_tokens + s.output_tokens)} tokens</span>
                            <Tag>{s.source === 'otel' ? 'OTel' : 'Agent'}</Tag>
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
