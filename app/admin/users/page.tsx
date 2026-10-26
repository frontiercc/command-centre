// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import Link from 'next/link';
import { PageBody, Panel, Tabs, Tag, Pill, Empty, T, B, cx } from '@/components/precision/ui';

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  last_seen_at: number | null;
  adoption_health: string;
  primary_surface: string;
  messages_7d: number;
  open_alerts: number;
  source: string | null;
}

interface DeactivatedUser {
  id: string;
  email: string;
  display_name: string | null;
  last_seen_at: number | null;
  deactivated_at: number | null;
  deactivation_reason: string | null;
  source: string | null;
}

type Tab = 'active' | 'deactivated';

function captureBadge(source: string | null): { label: string; title: string } {
  if (source === 'otel') return { label: 'OTel', title: 'Monitored via OpenTelemetry' };
  if (source === 'compliance') return { label: 'Compliance API', title: 'Synced via the Anthropic Compliance API' };
  return { label: 'Telemetry', title: 'Monitored via telemetry' };
}

/** Quiet row action (Deactivate). */
const ROW_ACTION =
  'inline-flex items-center justify-center text-[13px] font-medium px-2.5 py-1 rounded-[10px] text-[#666666] hover:text-[#0A0A0A] hover:bg-[#F2F2F2] disabled:opacity-50 disabled:cursor-not-allowed';

/** Delete: quiet until the first click arms it, then solid red "Confirm?". */
function deleteClass(armed: boolean): string {
  return armed
    ? 'inline-flex items-center justify-center text-[13px] font-medium px-2.5 py-1 rounded-[10px] bg-[#B42318] text-white hover:bg-[#912018] disabled:opacity-50 disabled:cursor-not-allowed'
    : 'inline-flex items-center justify-center text-[13px] font-medium px-2.5 py-1 rounded-[10px] text-[#8F8F8F] hover:text-[#B42318] hover:bg-[#FFF5F4] disabled:opacity-50 disabled:cursor-not-allowed';
}

/** Adoption health as a status pill (active / shallow / inactive). */
function healthTone(value: string): 'good' | 'warn' | 'neutral' {
  if (value === 'active') return 'good';
  if (value === 'shallow') return 'warn';
  return 'neutral';
}

function formatDate(epochS: number | null): string {
  return epochS ? new Date(epochS * 1000).toLocaleDateString('en-GB') : '—';
}

export default function UsersPage() {
  const [tab, setTab] = useState<Tab>('active');
  const [users, setUsers] = useState<UserRow[]>([]);
  const [deactivated, setDeactivated] = useState<DeactivatedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingDeactivated, setLoadingDeactivated] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/users')
      .then(r => r.json())
      .then(setUsers)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (tab !== 'deactivated') return;
    setLoadingDeactivated(true);
    fetch('/api/users?deactivated=true')
      .then(r => r.json())
      .then(setDeactivated)
      .catch(console.error)
      .finally(() => setLoadingDeactivated(false));
  }, [tab]);

  function handleDelete(userId: string) {
    if (confirmDelete !== userId) {
      setConfirmDelete(userId);
      return;
    }
    setWorking(userId);
    fetch(`/api/users?userId=${encodeURIComponent(userId)}`, { method: 'DELETE' })
      .then(r => r.json())
      .then(() => {
        setUsers(prev => prev.filter(u => u.id !== userId));
        setDeactivated(prev => prev.filter(u => u.id !== userId));
        setConfirmDelete(null);
      })
      .catch(console.error)
      .finally(() => setWorking(null));
  }

  function handleDeactivate(userId: string) {
    setWorking(userId);
    fetch('/api/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: userId, action: 'deactivate' }),
    })
      .then(r => r.json())
      .then(() => {
        const user = users.find(u => u.id === userId);
        if (user) {
          setDeactivated(prev => [...prev, {
            id: user.id,
            email: user.email,
            display_name: user.display_name,
            last_seen_at: user.last_seen_at,
            deactivated_at: Math.floor(Date.now() / 1000),
            deactivation_reason: 'manual_admin',
            source: user.source,
          }]);
        }
        setUsers(prev => prev.filter(u => u.id !== userId));
      })
      .catch(console.error)
      .finally(() => setWorking(null));
  }

  function handleReactivate(userId: string) {
    setWorking(userId);
    fetch('/api/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: userId, action: 'reactivate' }),
    })
      .then(r => r.json())
      .then(() => {
        setDeactivated(prev => prev.filter(u => u.id !== userId));
        // Refresh active users
        return fetch('/api/users').then(r => r.json()).then(setUsers);
      })
      .catch(console.error)
      .finally(() => setWorking(null));
  }

  const tabs: Array<{ value: Tab; label: ReactNode }> = [
    { value: 'active', label: 'Active' },
    {
      value: 'deactivated',
      label: (
        <span className="inline-flex items-center gap-1.5">
          Deactivated
          {deactivated.length > 0 && (
            <span className="text-[12px] text-[#245BF3] tabular-nums">{deactivated.length}</span>
          )}
        </span>
      ),
    },
  ];

  return (
    <>
      <TopBar title="User Insights" subtitle="User adoption and engagement tracking" />
      <PageBody>
        <Tabs tabs={tabs} value={tab} onChange={setTab} label="User status" />

        {/* Active users tab */}
        {tab === 'active' && (
          loading ? (
            <LoadingSpinner />
          ) : users.length === 0 ? (
            <Empty title="No users found">
              No user data available. Analytics API data arrives with a 3-day delay.
            </Empty>
          ) : (
            <Panel title="Active users" subtitle={`${users.length} ${users.length === 1 ? 'person' : 'people'}`} flush>
              <div className="overflow-x-auto">
                <table className={T.table}>
                  <thead>
                    <tr className={T.headRow}>
                      <th className={T.th}>Name / email</th>
                      <th className={T.th}>Last active</th>
                      <th className={T.th}>Primary surface</th>
                      <th className={T.thRight}>Messages (7d)</th>
                      <th className={T.th}>Adoption</th>
                      <th className={T.thRight}>Alerts</th>
                      <th className={T.th}><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map(user => {
                      const badge = captureBadge(user.source);
                      return (
                        <tr key={user.id} className={T.row}>
                          <td className={T.td}>
                            <div className="flex items-center gap-2">
                              <Tag tone="measured" title={badge.title}>{badge.label}</Tag>
                              <div className="min-w-0">
                                <Link href={`/admin/users/${user.id}`} className="text-[#0A0A0A] font-medium hover:text-[#245BF3] hover:underline">
                                  {user.display_name || user.email}
                                </Link>
                                {user.display_name && (
                                  <p className="m-0 text-[13px] text-[#8F8F8F]">{user.email}</p>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className={cx(T.tdMute, 'whitespace-nowrap tabular-nums')}>{formatDate(user.last_seen_at)}</td>
                          <td className={T.td}>
                            <Tag>{user.primary_surface.toLowerCase()}</Tag>
                          </td>
                          <td className={cx(T.tdRight, 'font-medium')}>{user.messages_7d}</td>
                          <td className={T.td}>
                            <Pill tone={healthTone(user.adoption_health)}>{user.adoption_health}</Pill>
                          </td>
                          <td className={T.tdRight}>
                            {user.open_alerts > 0 ? (
                              <span className="text-[#B42318] font-medium">{user.open_alerts}</span>
                            ) : (
                              <span className="text-[#B3B3B3]">0</span>
                            )}
                          </td>
                          <td className={T.tdRight}>
                            <div className="flex items-center justify-end gap-1">
                              <button
                                type="button"
                                onClick={() => handleDeactivate(user.id)}
                                disabled={working === user.id}
                                className={ROW_ACTION}
                              >
                                Deactivate
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDelete(user.id)}
                                onBlur={() => setConfirmDelete(null)}
                                disabled={working === user.id}
                                className={deleteClass(confirmDelete === user.id)}
                              >
                                {confirmDelete === user.id ? 'Confirm?' : 'Delete'}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Panel>
          )
        )}

        {/* Deactivated users tab */}
        {tab === 'deactivated' && (
          loadingDeactivated ? (
            <LoadingSpinner />
          ) : deactivated.length === 0 ? (
            <Empty title="No deactivated users">
              Users soft-deactivated by the automated cleanup (30-day inactivity) or manually will appear here.
            </Empty>
          ) : (
            <Panel title="Deactivated users" subtitle={`${deactivated.length} ${deactivated.length === 1 ? 'person' : 'people'}`} flush>
              <div className="overflow-x-auto">
                <table className={T.table}>
                  <thead>
                    <tr className={T.headRow}>
                      <th className={T.th}>Name / email</th>
                      <th className={T.th}>Last active</th>
                      <th className={T.th}>Deactivated</th>
                      <th className={T.th}>Reason</th>
                      <th className={T.th}><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {deactivated.map(user => (
                      <tr key={user.id} className={T.row}>
                        <td className={T.td}>
                          <div className="flex items-center gap-2">
                            {user.source === 'otel' && <Tag tone="measured">OTel</Tag>}
                            <div className="min-w-0">
                              <span className="text-[#4D4D4D] font-medium">{user.display_name || user.email}</span>
                              {user.display_name && (
                                <p className="m-0 text-[13px] text-[#8F8F8F]">{user.email}</p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className={cx(T.tdMute, 'whitespace-nowrap tabular-nums')}>{formatDate(user.last_seen_at)}</td>
                        <td className={cx(T.tdMute, 'whitespace-nowrap tabular-nums')}>{formatDate(user.deactivated_at)}</td>
                        <td className={cx(T.tdMute, 'text-[13px]')}>
                          {user.deactivation_reason === 'stale_otel_auto'
                            ? 'Auto (30d inactive)'
                            : user.deactivation_reason === 'manual_admin'
                            ? 'Manual'
                            : (user.deactivation_reason ?? '—')}
                        </td>
                        <td className={T.tdRight}>
                          <div className="flex items-center justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => handleReactivate(user.id)}
                              disabled={working === user.id}
                              className={B.secondary}
                            >
                              Reactivate
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDelete(user.id)}
                              onBlur={() => setConfirmDelete(null)}
                              disabled={working === user.id}
                              className={deleteClass(confirmDelete === user.id)}
                            >
                              {confirmDelete === user.id ? 'Confirm?' : 'Delete'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )
        )}
      </PageBody>
    </>
  );
}
