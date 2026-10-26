// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { useToast } from '@/components/shared/ToastProvider';
import { PageBody, Panel, Strip, Figure, Pill, Dot, SEVERITY_COLOR, Notice, Empty, Muted, SubHead, T, B, cx } from '@/components/precision/ui';

/** Adoption health as a status pill (active / shallow / inactive). */
function healthTone(value: string): 'good' | 'warn' | 'neutral' {
  if (value === 'active') return 'good';
  if (value === 'shallow') return 'warn';
  return 'neutral';
}

/** Alert status as a pill. */
function statusTone(value: string): 'bad' | 'warn' | 'good' | 'neutral' {
  if (value === 'open') return 'bad';
  if (value === 'acknowledged') return 'warn';
  if (value === 'resolved') return 'good';
  return 'neutral';
}

interface UserDetail {
  id: string;
  email: string;
  display_name: string | null;
  department: string | null;
  first_seen_at: number | null;
  last_seen_at: number | null;
  adoption_health: string;
  primary_surface: string;
  messages_7d: number;
  alerts: Array<{
    id: string;
    severity: string;
    title: string;
    status: string;
    generated_at: number;
  }>;
  snapshots_30d: Array<{
    snapshot_date: string;
    messages_sent: number;
    surface_chat: number;
    surface_code: number;
    surface_cowork: number;
  }>;
  source: string | null;
  coworkActivity?: {
    projects: Array<{ project_name: string; session_count: number; files: string[] }>;
    recentSessions: Array<{
      id: string; project_name: string | null; files_touched_count: number;
      started_at: number; ended_at: number | null;
    }>;
  };
}

export default function UserDetailPage() {
  const params = useParams();
  const userId = decodeURIComponent(params.id as string);
  const [user, setUser] = useState<UserDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [alias, setAlias] = useState('');
  const [department, setDepartment] = useState('');
  // Departments already in use, offered as suggestions on the free-text field
  // below. Kept as a datalist rather than a <select> so a genuinely new
  // department can still be typed — this page is the only place the FIRST
  // department on an instance can be created, and /admin/security's dropdown
  // is populated from exactly this data.
  const [knownDepartments, setKnownDepartments] = useState<string[]>([]);
  /** True when "add a new department" is selected and `department` is typed. */
  const [deptAddingNew, setDeptAddingNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const { showToast } = useToast();
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    fetch(`/api/users?id=${userId}`)
      .then(r => r.json())
      .then(data => {
        setUser(data);
        setAlias(data.display_name || '');
        setDepartment(data.department || '');
      })
      .catch(console.error)
      .finally(() => setLoading(false));

    // Union of departments on monitored users AND on login accounts. Reading
    // only /api/users leaves the list empty on instances where departments
    // exist solely as account restrictions — the same bug the picker on
    // /admin/security had.
    Promise.all([
      fetch('/api/users').then(r => (r.ok ? r.json() : [])).catch(() => []),
      fetch('/api/admin/users').then(r => (r.ok ? r.json() : null)).catch(() => null),
    ])
      .then(([monitored, adminData]) => {
        const fromMonitored = (Array.isArray(monitored) ? monitored : [])
          .map((u: { department?: string | null }) => u.department);
        const fromAccounts = (adminData?.users ?? [])
          .map((u: { department?: string | null }) => u.department);
        setKnownDepartments(
          [...new Set([...fromMonitored, ...fromAccounts].filter((d): d is string => Boolean(d)))].sort(),
        );
      })
      .catch(() => {});
  }, [userId]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/users', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: userId, display_name: alias || null, department: department || null }),
      });
      if (res.ok) {
        setUser(prev => prev ? { ...prev, display_name: alias || null, department: department || null } : prev);
        // A newly typed department becomes selectable immediately, without a
        // reload — it is now a real department as far as the rest of the app
        // is concerned.
        if (department) {
          setKnownDepartments(prev => (prev.includes(department) ? prev : [...prev, department].sort()));
        }
        setDeptAddingNew(false);
        setEditing(false);
        showToast('User saved successfully', 'success');
      } else {
        const data = await res.json();
        showToast(data.error || 'Failed to save user', 'error');
      }
    } catch {
      showToast('Failed to save user', 'error');
    } finally {
      setSaving(false);
    }
  };

  async function handleExport() {
    setExporting(true);
    try {
      const res = await fetch(`/api/users/export?id=${userId}`);
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `user-export-${userId}-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export failed:', err);
    } finally {
      setExporting(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/users?id=${userId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Deletion failed');
      window.location.href = '/admin/users';
    } catch (err) {
      console.error('Deletion failed:', err);
      setDeleting(false);
    }
  }

  if (loading) return (
    <>
      <TopBar title="User Detail" />
      <LoadingSpinner />
    </>
  );

  if (!user) return (
    <>
      <TopBar title="User Detail" />
      <PageBody>
        <Empty title="User not found." />
      </PageBody>
    </>
  );

  return (
    <>
      <TopBar
        title={user.display_name || user.id}
        subtitle={user.id}
      />
      <PageBody>
        {/* User identity — alias and department */}
        <Panel
          title="User identity"
          right={!editing ? (
            <button type="button" onClick={() => setEditing(true)} className={B.link}>
              Edit
            </button>
          ) : undefined}
        >
          {editing ? (
            <div className="flex flex-col gap-4 max-w-xl">
              <label className="flex flex-col gap-1.5 text-[14px] font-medium text-[#0A0A0A]">
                Display name / alias
                <input
                  type="text"
                  value={alias}
                  onChange={e => setAlias(e.target.value)}
                  className={cx(B.input, 'w-full font-normal')}
                  placeholder="e.g. Jane Smith"
                />
                <span className="text-[13px] font-normal text-[#8F8F8F]">Friendly name shown across the dashboard instead of the user ID.</span>
              </label>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="user-department" className="text-[14px] font-medium text-[#0A0A0A]">Department</label>
                <select
                  id="user-department"
                  value={deptAddingNew ? '__new__' : department}
                  onChange={e => {
                    if (e.target.value === '__new__') {
                      setDeptAddingNew(true);
                      setDepartment('');
                    } else {
                      setDeptAddingNew(false);
                      setDepartment(e.target.value);
                    }
                  }}
                  className={cx(B.select, 'w-full text-[14px]')}
                >
                  <option value="">None</option>
                  {knownDepartments.map(d => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                  <option value="__new__">+ Add a new department…</option>
                </select>
                {deptAddingNew && (
                  <input
                    autoFocus
                    type="text"
                    value={department}
                    onChange={e => setDepartment(e.target.value)}
                    placeholder="New department name"
                    aria-label="New department name"
                    className={cx(B.input, 'w-full')}
                  />
                )}
                <span className="text-[13px] text-[#8F8F8F]">
                  User&apos;s department or organisational unit. Saving a new one adds it to the list everywhere departments are offered.
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className={B.primary}
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={() => { setEditing(false); setAlias(user?.display_name || ""); setDepartment(user?.department || ""); }}
                  className={B.secondary}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <dl className="m-0 grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-8">
              <div className="min-w-0">
                <dt className="text-[13px] text-[#8F8F8F]">User ID</dt>
                <dd className="m-0 mt-0.5 text-[14px] text-[#0A0A0A] font-mono break-all">{userId}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[13px] text-[#8F8F8F]">Display name</dt>
                <dd className="m-0 mt-0.5 text-[14px] text-[#0A0A0A]">{user?.display_name || <span className="text-[#8F8F8F]">Not set</span>}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[13px] text-[#8F8F8F]">Department</dt>
                <dd className="m-0 mt-0.5 text-[14px] text-[#0A0A0A]">{user?.department || <span className="text-[#8F8F8F]">Not set</span>}</dd>
              </div>
            </dl>
          )}
        </Panel>

        {/* GDPR Actions */}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            className={B.secondary}
          >
            {exporting ? 'Exporting...' : 'Export data'}
          </button>

          <button
            type="button"
            onClick={() => setShowDeleteConfirm(true)}
            className={B.danger}
          >
            Delete all data
          </button>
        </div>

        {showDeleteConfirm && (
          <div className="fixed inset-0 bg-[rgba(10,10,10,0.25)] flex items-center justify-center z-50 p-4">
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="delete-user-title"
              className="bg-white border border-[#EAEAEA] rounded-[16px] w-full max-w-md"
            >
              <div className="px-4 py-3 border-b border-[#EAEAEA]">
                <h3 id="delete-user-title" className="m-0 text-[14px] font-semibold text-[#0A0A0A]">Confirm deletion</h3>
              </div>
              <p className="m-0 px-4 py-4 text-[14px] leading-5 text-[#4D4D4D]">
                This will permanently delete all data for this user including conversation
                content, events, snapshots, and alerts. This action cannot be undone.
              </p>
              <div className="flex gap-2 justify-end px-4 py-3 border-t border-[#F2F2F2]">
                <button
                  type="button"
                  onClick={() => setShowDeleteConfirm(false)}
                  className={B.secondary}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => { setShowDeleteConfirm(false); handleDelete(); }}
                  disabled={deleting}
                  className="inline-flex items-center justify-center gap-1.5 text-[13px] font-medium px-3 py-1.5 rounded-[10px] bg-[#B42318] text-white hover:bg-[#912018] disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {deleting ? 'Deleting...' : 'Delete permanently'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Summary figures */}
        {user.source === 'otel' ? (
          <Notice tone="info">
            OTel user, monitored via Claude Desktop Teams.
          </Notice>
        ) : (
          <Strip cols={4}>
            <Figure
              label="Adoption health"
              value={<Pill tone={healthTone(user.adoption_health)}>{user.adoption_health}</Pill>}
            />
            <Figure label="Primary surface" value={user.primary_surface} />
            <Figure label="Messages (7d)" value={user.messages_7d} />
            <Figure
              label="Last active"
              value={user.last_seen_at
                ? new Date(user.last_seen_at * 1000).toLocaleDateString('en-GB')
                : 'Never'}
            />
          </Strip>
        )}

        {/* 30-day activity */}
        <Panel title="30-day activity" subtitle={user.snapshots_30d.length > 0 ? 'Latest 14 days' : undefined} flush>
          {user.snapshots_30d.length === 0 ? (
            <div className="p-4"><Muted>No activity data available.</Muted></div>
          ) : (
            <div className="overflow-x-auto">
              <table className={T.table}>
                <thead>
                  <tr className={T.headRow}>
                    <th className={T.th}>Date</th>
                    <th className={T.thRight}>Messages</th>
                    <th className={T.thRight}>Chat</th>
                    <th className={T.thRight}>Code</th>
                    <th className={T.thRight}>Cowork</th>
                  </tr>
                </thead>
                <tbody>
                  {user.snapshots_30d.slice(-14).map(s => (
                    <tr key={s.snapshot_date} className={T.row}>
                      <td className={cx(T.td, 'tabular-nums')}>{s.snapshot_date}</td>
                      <td className={cx(T.tdRight, 'font-medium')}>{s.messages_sent}</td>
                      <td className={cx(T.tdRight, 'text-[#4D4D4D]')}>{s.surface_chat}</td>
                      <td className={cx(T.tdRight, 'text-[#4D4D4D]')}>{s.surface_code}</td>
                      <td className={cx(T.tdRight, 'text-[#4D4D4D]')}>{s.surface_cowork}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* User alerts */}
        <Panel title="Associated alerts" flush>
          {user.alerts.length === 0 ? (
            <div className="p-4"><Muted>No alerts for this user.</Muted></div>
          ) : (
            <div>
              {user.alerts.map(alert => (
                <div key={alert.id} className="flex items-center gap-3 px-4 py-2.5 border-t border-[#F2F2F2] first:border-t-0">
                  <span className="w-20 shrink-0">
                    <Dot color={SEVERITY_COLOR[alert.severity] ?? SEVERITY_COLOR.low}>
                      <span className="capitalize text-[#4D4D4D]">{alert.severity}</span>
                    </Dot>
                  </span>
                  <span className="text-[14px] text-[#0A0A0A] flex-1 min-w-0">{alert.title}</span>
                  <Pill tone={statusTone(alert.status)}>{alert.status}</Pill>
                  <span className="text-[13px] text-[#8F8F8F] tabular-nums whitespace-nowrap">
                    {new Date(alert.generated_at * 1000).toLocaleDateString('en-GB')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Panel>

        {/* Cowork Activity */}
        <Panel title="Cowork activity" subtitle="30 days">
          {!user.coworkActivity || user.coworkActivity.projects.length === 0 ? (
            <Empty title="No cowork project data yet">
              Project and file tracking will appear here once cowork sessions are captured.
            </Empty>
          ) : (
            <div className="flex flex-col gap-5">
              <div>
                <SubHead>Projects touched</SubHead>
                <div className="border border-[#EAEAEA] rounded-[10px]">
                  {user.coworkActivity.projects.map(p => (
                    <details key={p.project_name} className="group border-t border-[#F2F2F2] first:border-t-0">
                      <summary className="flex items-center justify-between gap-3 cursor-pointer hover:bg-[#FAFAFA] px-3 py-2">
                        <span className="text-[14px] font-medium text-[#0A0A0A]">{p.project_name}</span>
                        <span className="text-[13px] text-[#8F8F8F] tabular-nums">{p.session_count} {p.session_count === 1 ? 'session' : 'sessions'}, {p.files.length} {p.files.length === 1 ? 'file' : 'files'}</span>
                      </summary>
                      <div className="px-3 pb-2 pl-6 flex flex-col gap-1">
                        {p.files.slice(0, 20).map(f => (
                          <p key={f} className="m-0 text-[13px] text-[#666666] font-mono truncate">{f}</p>
                        ))}
                        {p.files.length > 20 && (
                          <p className="m-0 text-[13px] text-[#8F8F8F]">... and {p.files.length - 20} more</p>
                        )}
                      </div>
                    </details>
                  ))}
                </div>
              </div>

              {user.coworkActivity.recentSessions.length > 0 && (
                <div>
                  <SubHead>Recent sessions</SubHead>
                  <div className="border border-[#EAEAEA] rounded-[10px]">
                    {user.coworkActivity.recentSessions.slice(0, 10).map(s => (
                      <div key={s.id} className="flex items-center justify-between gap-3 px-3 py-2 border-t border-[#F2F2F2] first:border-t-0 text-[14px]">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-[#0A0A0A] truncate">{s.project_name || 'Unknown project'}</span>
                          <span className="text-[13px] text-[#8F8F8F] tabular-nums">{s.files_touched_count} {s.files_touched_count === 1 ? 'file' : 'files'}</span>
                        </div>
                        <span className="text-[13px] text-[#666666] tabular-nums whitespace-nowrap">
                          {new Date(s.started_at * 1000).toLocaleDateString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </Panel>
      </PageBody>
    </>
  );
}
