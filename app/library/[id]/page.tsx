// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0
// Some icon drawings in this file are from Heroicons (MIT); see THIRD-PARTY-NOTICES.md.

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { isWebUrl } from '@/lib/library/source-url';
import {
  PageBody, Toolbar, Panel, Strip, Figure, BarRow, Tag, Pill, B, Notice, Muted, deltaTone, cx,
} from '@/components/precision/ui';

interface DayCount { day: string; cnt: number; }
interface TopUser  { user_id: string; display_name: string | null; cnt: number; }
interface WorkflowUsingSignal { id: string; title: string; lifecycle: string; distinctUsers: number; lastSeenAt: number | null; }

interface EntryDetail {
  id: number;
  name: string;
  type: string;
  surface: string;
  source: string;
  description: string | null;
  author_name: string | null;
  is_published: number;
  is_author: boolean;
  install_guide: string | null;
  source_url: string | null;
  department: string | null;
  created_at: number;
  stats: {
    total_invocations: number;
    week_count: number;
    trend_pct: number;
    distinct_users: number;
    vote_count: number;
    user_voted: boolean;
    agent_chained_pct: number;
  };
  daily_counts: DayCount[];
  top_users: TopUser[];
  usedInWorkflows: WorkflowUsingSignal[] | null;
  /** Set when this entry is a skill codified from a use case (Turn this into a skill). */
  codified: { useCaseId: string; useCaseTitle: string } | null;
}

const LIFECYCLE_PILL: Record<string, { label: string; tone: 'good' | 'info' | 'warn' | 'neutral' }> = {
  adopted: { label: 'Adopted', tone: 'good' },
  piloting: { label: 'Piloting', tone: 'info' },
  at_risk: { label: 'At risk', tone: 'warn' },
  not_seen: { label: 'Not seen', tone: 'neutral' },
};

const FIELD_LABEL = 'block text-[13px] font-medium text-[#4D4D4D] mb-1';
const FIELD_HINT = 'font-normal text-[#8F8F8F]';

function DownloadIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
    </svg>
  );
}

/** Line icon (24px grid, currentColor stroke). */
function LineIcon({ d, className }: { d: string; className?: string }) {
  return (
    <svg aria-hidden="true" width={14} height={14} className={cx('shrink-0', className)} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

const ICON = {
  back: 'M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18',
  skill: 'M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z',
  connector: 'M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244',
  edit: 'M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125',
  agent: 'M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23-.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5',
  user: 'M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z',
};

function initials(name: string | null, id: string): string {
  if (!name) return id.slice(0, 2).toUpperCase();
  return name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
}

export default function LibraryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const [entry, setEntry] = useState<EntryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [id, setId] = useState<string>('');
  const [editing, setEditing] = useState(false);
  const [editDesc, setEditDesc] = useState('');
  const [editGuide, setEditGuide] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [editDept, setEditDept] = useState('');
  const [departments, setDepartments] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [callerRole, setCallerRole] = useState<string | null>(null);

  useEffect(() => {
    params.then(p => setId(p.id));
  }, [params]);

  useEffect(() => {
    if (!id) return;
    fetch(`/api/library/${id}`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(setEntry)
      .catch(() => router.push('/library'))
      .finally(() => setLoading(false));
  }, [id, router]);

  useEffect(() => {
    fetch('/api/users')
      .then(r => r.ok ? r.json() : [])
      .then((rows: Array<{ department?: string | null }>) => {
        const depts = [...new Set(rows.map(u => u.department).filter((d): d is string => Boolean(d)))].sort();
        setDepartments(depts);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/admin/session')
      .then(r => r.json())
      .then(data => setCallerRole(data.authenticated ? (data.user?.role ?? null) : null))
      .catch(() => {});
  }, []);
  const isAdminOrManager = callerRole === 'admin' || callerRole === 'manager';

  // Delete: admins and managers, any entry, two-step confirm.
  const [deleteState, setDeleteState] = useState<'idle' | 'confirm' | 'deleting'>('idle');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const handleDelete = async () => {
    if (!entry) return;
    setDeleteState('deleting'); setDeleteError(null);
    const res = await fetch(`/api/library/${entry.id}`, { method: 'DELETE' }).catch(() => null);
    if (res && res.ok) { router.push('/library'); return; }
    const body = res ? await res.json().catch(() => ({})) : {};
    setDeleteError(typeof body.error === 'string' && body.error !== 'delete_failed' ? body.error : 'Could not delete this entry. Try again.');
    setDeleteState('confirm');
  };

  const handleVote = async () => {
    if (!entry || !id) return;
    const res = await fetch(`/api/library/${id}/vote`, { method: 'POST' });
    if (!res.ok) return;
    const { voted, count } = await res.json();
    setEntry(prev => prev ? { ...prev, stats: { ...prev.stats, user_voted: voted, vote_count: count } } : prev);
  };

  const copyInstall = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const openEdit = () => {
    if (!entry) return;
    setEditDesc(entry.description ?? '');
    setEditGuide(entry.install_guide ?? '');
    setEditUrl(entry.source_url ?? '');
    setEditDept(entry.department ?? '');
    setSaveError('');
    setEditing(true);
  };

  const handleSave = async () => {
    if (!id) return;
    setSaving(true);
    setSaveError('');
    const res = await fetch(`/api/library/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: editDesc || null, install_guide: editGuide || null, source_url: editUrl || null, ...(isAdminOrManager ? { department: editDept || null } : {}) }),
    });
    setSaving(false);
    if (!res.ok) {
      // Show the server's reason when it gives one (e.g. a source link that is not a web address).
      const body = await res.json().catch(() => ({}));
      setSaveError(typeof body.error === 'string' && res.status === 400 ? body.error : 'Save failed. Please try again.');
      return;
    }
    setEntry(prev => prev ? { ...prev, description: editDesc || null, install_guide: editGuide || null, source_url: editUrl || null, department: isAdminOrManager ? (editDept || null) : prev.department } : prev);
    setEditing(false);
  };

  if (loading) return (
    <>
      <TopBar title="Loading…" />
      <LoadingSpinner />
    </>
  );
  if (!entry) return null;

  const isTrending = entry.stats.trend_pct >= 20;
  const maxDay = Math.max(...entry.daily_counts.map(d => d.cnt), 1);

  // Build last-7-days labels even if no data for some days
  const last7: DayCount[] = Array.from({ length: 7 }).map((_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    const key = d.toISOString().slice(0, 10);
    const label = d.toLocaleDateString('en-GB', { weekday: 'short' });
    return { day: label, cnt: entry.daily_counts.find(r => r.day === key)?.cnt ?? 0 };
  });

  const installBody = (() => {
    if (entry.codified && !isAdminOrManager) {
      // Viewers get one line and no button.
      return (
        <p className="m-0 text-[14px] text-[#4D4D4D]">
          Distributed through your organisation’s skills library. Once enabled by an admin it appears in your directory.
        </p>
      );
    }
    if (entry.codified) {
      // One button and one line: no guide text, no link back to the use
      // case page, which would send people round in a circle.
      return (
        <div className="flex flex-col gap-2 items-start">
          <a
            href={`/api/use-cases/${encodeURIComponent(entry.codified.useCaseId)}/skill-draft/zip`}
            download
            className={B.primary}
          >
            <DownloadIcon />
            Download skill (zip)
          </a>
          <p className="m-0 text-[13px] text-[#4D4D4D]">
            Upload the zip in Organisation settings → Plugins &amp; skills.
          </p>
          <p className="m-0 text-[13px] text-[#8F8F8F]">
            Drafted from the use case <Link href={`/use-cases/${encodeURIComponent(entry.codified.useCaseId)}`} className="text-[#245BF3] hover:underline">{entry.codified.useCaseTitle}</Link>.
          </p>
        </div>
      );
    }
    const eligible = entry.is_published === 1 && !!entry.install_guide;
    if (eligible) {
      return (
        <div className="flex flex-col gap-2">
          <div className="flex items-start gap-3 bg-[#FAFAFA] border border-[#EAEAEA] rounded-[10px] px-3 py-2.5 text-[13px] text-[#0A0A0A]">
            <p className="m-0 whitespace-pre-wrap flex-1 font-mono">{entry.install_guide}</p>
            <button
              type="button"
              onClick={() => copyInstall(entry.install_guide!)}
              aria-label={copied ? 'Copied' : 'Copy install guide'}
              className="text-[#8F8F8F] hover:text-[#0A0A0A] shrink-0"
            >
              {copied ? (
                <svg className="w-4 h-4 text-[#1A7F37]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                </svg>
              )}
            </button>
          </div>
          {isWebUrl(entry.source_url) && (
            <a href={entry.source_url} target="_blank" rel="noopener noreferrer" className={cx(B.link, 'inline-flex items-center gap-1 self-start')}>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
              </svg>
              View source
            </a>
          )}
        </div>
      );
    }
    return (
      <div className="flex items-center justify-between gap-3">
        <Muted>{entry.is_published === 1 ? 'No install guide yet.' : 'Not claimed yet. Install is disabled until it is.'}</Muted>
        {(entry.is_author || isAdminOrManager) && (
          <button type="button" onClick={openEdit} className={B.link}>
            Add via Edit
          </button>
        )}
      </div>
    );
  })();

  return (
    <>
      <TopBar
        title={entry.name}
        subtitle={entry.type === 'skill' ? 'Skill' : 'Connector'}
      />
      <PageBody>
        <Toolbar
          left={
            <span className="flex flex-wrap items-center gap-2">
              <Link href="/library" className="inline-flex items-center gap-1 text-[#245BF3] hover:underline">
                <LineIcon d={ICON.back} />
                Back to the S&amp;C Board
              </Link>
              <span className="text-[#D4D4D4]" aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1.5">
                <LineIcon d={entry.type === 'skill' ? ICON.skill : ICON.connector} className="text-[#8F8F8F]" />
                <Tag>{entry.type}</Tag>
              </span>
              {isTrending && <Tag tone="measured">Trending +{entry.stats.trend_pct}%</Tag>}
              {entry.author_name && <span className="text-[#666666]">by <strong className="font-medium text-[#0A0A0A]">{entry.author_name}</strong></span>}
              <span className="text-[#666666]">{entry.surface === 'both' ? 'Code + Cowork' : entry.surface}</span>
            </span>
          }
        >
          <button
            type="button"
            onClick={handleVote}
            aria-pressed={!!entry.stats.user_voted}
            className={cx(B.secondary, entry.stats.user_voted && '!border-[#245BF3] !text-[#245BF3] !bg-[#F2F5FF]')}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
            </svg>
            <span className="tabular-nums">{entry.stats.vote_count}</span> votes
          </button>
          {entry.codified ? (
            // A codified skill: the action is the zip itself, admins and managers
            // only (the zip route is gated the same way, so nobody else ever
            // meets a 403). No button for anyone else.
            isAdminOrManager && (
              <a
                href={`/api/use-cases/${encodeURIComponent(entry.codified.useCaseId)}/skill-draft/zip`}
                download
                className={B.primary}
              >
                <DownloadIcon />
                Download skill
              </a>
            )
          ) : (entry.is_published === 1 && entry.install_guide && (
            <button type="button" onClick={() => copyInstall(entry.install_guide!)} className={B.primary}>
              <DownloadIcon />
              Install
            </button>
          ))}
          {!editing && (entry.is_author || isAdminOrManager) && (
            <button type="button" onClick={openEdit} className={B.secondary}>
              <LineIcon d={ICON.edit} />
              Edit
            </button>
          )}
          {isAdminOrManager && deleteState === 'idle' && (
            <button
              type="button"
              onClick={() => { setDeleteError(null); setDeleteState('confirm'); }}
              className={B.danger}
            >
              Delete
            </button>
          )}
        </Toolbar>

        {deleteState !== 'idle' && (
          <Notice
            tone="error"
            title={<>Delete {entry.name} from the S&amp;C Board?</>}
            action={
              <span className="flex gap-2">
                <button type="button" onClick={handleDelete} disabled={deleteState === 'deleting'} className={B.danger}>
                  {deleteState === 'deleting' ? 'Deleting…' : 'Delete'}
                </button>
                <button type="button" onClick={() => setDeleteState('idle')} disabled={deleteState === 'deleting'} className={B.secondary}>
                  Cancel
                </button>
              </span>
            }
          >
            {entry.codified
              ? <>This removes the card, takes the skill off the matching rule of {entry.codified.useCaseTitle}, and puts its draft back to not-yet-downloaded so the owner can fix it and download again, or discard it. Recorded usage stays.</>
              : <>This removes the card and its votes. Recorded usage stays, and if this {entry.type} is used again it will reappear here unclaimed.</>}
            {deleteError && <span className="block mt-1 font-medium text-[#B42318]">{deleteError}</span>}
          </Notice>
        )}

        <Strip cols={4}>
          <Figure label="Total invocations" value={entry.stats.total_invocations.toLocaleString()} sub="All time" />
          <Figure
            label="This week"
            value={entry.stats.week_count.toLocaleString()}
            delta={`${entry.stats.trend_pct >= 0 ? '+' : ''}${entry.stats.trend_pct}% vs last week`}
            deltaTone={deltaTone(entry.stats.trend_pct)}
          />
          <Figure label="Users" value={entry.stats.distinct_users.toLocaleString()} />
          <Figure label="Upvotes" value={entry.stats.vote_count.toLocaleString()} sub={entry.stats.user_voted ? 'You voted' : undefined} />
        </Strip>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 flex flex-col gap-4 min-w-0">
            {/* About / Edit panel */}
            <Panel title="About" right={editing ? <Tag>Editing</Tag> : undefined}>
              {editing ? (
                <div className="flex flex-col gap-3">
                  <div>
                    <label htmlFor="lib-edit-desc" className={FIELD_LABEL}>Description</label>
                    <textarea
                      id="lib-edit-desc"
                      value={editDesc}
                      onChange={e => setEditDesc(e.target.value)}
                      rows={3}
                      className={cx(B.input, 'w-full resize-none')}
                      placeholder="What does it do, when should teammates use it?"
                    />
                  </div>
                  <div>
                    <label htmlFor="lib-edit-guide" className={FIELD_LABEL}>Install guide <span className={FIELD_HINT}>(optional: steps to set this up, or a command to run)</span></label>
                    <textarea
                      id="lib-edit-guide"
                      value={editGuide}
                      onChange={e => setEditGuide(e.target.value)}
                      rows={4}
                      className={cx(B.input, 'w-full resize-none font-mono')}
                      placeholder={'e.g.\n1. Copy this file to ~/.claude/commands/\n2. Restart Claude Code\n3. Run /deep-research'}
                    />
                  </div>
                  <div>
                    <label htmlFor="lib-edit-url" className={FIELD_LABEL}>Source link <span className={FIELD_HINT}>(optional: GitHub, Notion, wiki)</span></label>
                    <input
                      id="lib-edit-url"
                      value={editUrl}
                      onChange={e => setEditUrl(e.target.value)}
                      className={cx(B.input, 'w-full')}
                      placeholder="https://..."
                    />
                  </div>
                  {isAdminOrManager && (
                    <div>
                      <label htmlFor="lib-edit-dept" className={FIELD_LABEL}>Department <span className={FIELD_HINT}>(optional: leave as &quot;org-wide&quot; unless this should be restricted)</span></label>
                      <select
                        id="lib-edit-dept"
                        value={editDept}
                        onChange={e => setEditDept(e.target.value)}
                        className={cx(B.input, 'w-full')}
                      >
                        <option value="">Org-wide: visible to everyone</option>
                        {departments.map(d => (
                          <option key={d} value={d}>{d}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  {saveError && <p className="m-0 text-[13px] text-[#B42318]">{saveError}</p>}
                  <div className="flex items-center gap-2 justify-end pt-1">
                    <button type="button" onClick={() => setEditing(false)} className={B.secondary}>Cancel</button>
                    <button type="button" onClick={handleSave} disabled={saving} className={B.primary}>
                      {saving ? 'Saving…' : 'Save changes'}
                    </button>
                  </div>
                </div>
              ) : entry.description ? (
                <p className="m-0 text-[14px] leading-6 text-[#333333]">{entry.description}</p>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <Muted>No description yet.</Muted>
                  {!entry.is_author && (
                    <Link href={`/library/submit?name=${encodeURIComponent(entry.name)}&type=${entry.type}`} className={B.link}>
                      Claim this skill
                    </Link>
                  )}
                </div>
              )}
            </Panel>

            {/* Powers these workflows */}
            {entry.usedInWorkflows && entry.usedInWorkflows.length > 0 && (
              <Panel title="Powers these workflows" flush>
                {entry.usedInWorkflows.map(wf => {
                  const pill = LIFECYCLE_PILL[wf.lifecycle] ?? LIFECYCLE_PILL.not_seen;
                  return (
                    <div key={wf.id} className="flex items-center gap-3 px-4 py-2.5 border-t border-[#F2F2F2] first:border-t-0 flex-wrap">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <Link href={`/use-cases/${wf.id}`} className="text-[14px] font-medium text-[#0A0A0A] hover:underline truncate">
                          {wf.title}
                        </Link>
                        <Pill tone={pill.tone}>{pill.label}</Pill>
                      </div>
                      <div className="flex items-center gap-3 text-[13px] text-[#8F8F8F] tabular-nums shrink-0">
                        <span>{wf.distinctUsers} {wf.distinctUsers === 1 ? 'person' : 'people'}, 13 weeks</span>
                        <span>
                          {wf.lastSeenAt
                            ? new Date(wf.lastSeenAt * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
                            : 'Not seen'}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </Panel>
            )}

            {/* 7-day usage */}
            <Panel title="Usage, last 7 days" right={<Tag tone="measured">Measured</Tag>} flush>
              {last7.map(d => (
                <BarRow
                  key={d.day}
                  label={d.day}
                  value={d.cnt.toLocaleString()}
                  pct={Math.round((d.cnt / maxDay) * 100)}
                  tone="measured"
                />
              ))}
            </Panel>

            {/* Invocation type */}
            {entry.stats.total_invocations > 0 && (
              <Panel
                title="How it's invoked"
                subtitle={entry.stats.agent_chained_pct > 50 ? 'Claude triggers this more than users do' : undefined}
                flush
              >
                <BarRow label={<><LineIcon d={ICON.agent} className="inline-block align-[-2px] mr-1.5 text-[#8F8F8F]" />Agent-chained</>} value={`${entry.stats.agent_chained_pct}%`} pct={entry.stats.agent_chained_pct} tone="measured" />
                <BarRow label={<><LineIcon d={ICON.user} className="inline-block align-[-2px] mr-1.5 text-[#8F8F8F]" />User-typed</>} value={`${100 - entry.stats.agent_chained_pct}%`} pct={100 - entry.stats.agent_chained_pct} tone="measured" />
              </Panel>
            )}
          </div>

          <div className="flex flex-col gap-4 min-w-0">
            {/* Install */}
            <Panel title="Install">{installBody}</Panel>

            {/* Used by */}
            {entry.top_users.length > 0 && (
              <Panel title="Used by" subtitle={<span className="tabular-nums">{entry.top_users.length}</span>}>
                <div className="flex flex-wrap gap-1.5">
                  {entry.top_users.slice(0, 8).map(u => (
                    <span key={u.user_id} className="inline-flex items-center gap-1.5 border border-[#EAEAEA] rounded-full pl-1 pr-2.5 py-0.5 text-[13px] text-[#333333]">
                      <span className="w-5 h-5 rounded-full bg-[#F2F2F2] text-[11px] font-semibold text-[#4D4D4D] inline-flex items-center justify-center">
                        {initials(u.display_name, u.user_id)}
                      </span>
                      {u.display_name ?? u.user_id}
                    </span>
                  ))}
                  {entry.top_users.length > 8 && (
                    <span className="inline-flex items-center px-2 py-0.5 text-[13px] text-[#8F8F8F] tabular-nums">
                      +{entry.top_users.length - 8} more
                    </span>
                  )}
                </div>
              </Panel>
            )}
          </div>
        </div>
      </PageBody>
    </>
  );
}

