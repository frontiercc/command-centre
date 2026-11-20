// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { ALL_CATEGORIES, CATEGORY_LABELS, alertTypeLabel, categoryForType } from '@/lib/alerts/categories';
import { useCorePlatformGuard } from '@/components/shared/useCorePlatformGuard';
import { useSessionRole } from '@/components/shared/useSessionRole';
import { PageBody, Panel, Segmented, Chip, Dot, Pill, Empty, Notice, B, SEVERITY_COLOR } from '@/components/precision/ui';

interface Alert {
  id: string;
  user_id: string | null;
  user_display_name?: string | null;
  alert_type: string;
  severity: string;
  title: string;
  explanation: string;
  raw_evidence: string | null;
  status: string;
  generated_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
}

const STATUSES = ['', 'open', 'acknowledged', 'resolved', 'dismissed'] as const;
const STATUS_LABEL: Record<string, string> = {
  '': 'All',
  open: 'Open',
  acknowledged: 'Acknowledged',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};
const STATUS_TONE: Record<string, 'bad' | 'warn' | 'good' | 'neutral'> = {
  open: 'bad',
  acknowledged: 'warn',
  resolved: 'good',
  dismissed: 'neutral',
};

/** getAlerts caps a list at 500 rows; past that, per-status counts would be wrong. */
const ALERT_LIST_CAP = 500;

export default function AlertsPage() {
  useCorePlatformGuard();
  // Only admins change an alert's status (the API refuses everyone else), so only they see the buttons.
  const isAdmin = useSessionRole() === 'admin';
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState('');
  const [category, setCategory] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Status-filtered (but category-independent) set used only to power the count strip,
  // so pill counts stay visible across all categories even once one is selected.
  const [statusAlerts, setStatusAlerts] = useState<Alert[]>([]);
  // Unfiltered set used only for the counts on the status switch.
  const [allAlerts, setAllAlerts] = useState<Alert[] | null>(null);

  // Bumped after a status change or a clear, to reload the list and the status counts.
  const [reloadKey, setReloadKey] = useState(0);
  const lastLoad = useRef<{ filter: string; category: string; reloadKey: number } | null>(null);

  // One effect loads the three sets the page shows: the list (status and
  // category), the status-only set (category counts) and the unfiltered set
  // (status counts). They often name the same address (no status or no
  // category picked), so each distinct address is requested once per load and
  // its answer shared. Before, three separate effects each fetched on page
  // open, so the same request went out three times.
  useEffect(() => {
    const prev = lastLoad.current;
    lastLoad.current = { filter, category, reloadKey };

    const requests = new Map<string, Promise<{ ok: boolean; status: number; data: unknown }>>();
    const get = (url: string) => {
      let p = requests.get(url);
      if (!p) {
        p = fetch(url).then(async r => ({ ok: r.ok, status: r.status, data: r.ok ? await r.json() : null }));
        requests.set(url, p);
      }
      return p;
    };

    // The list: on every change.
    const params = new URLSearchParams();
    if (filter) params.set('status', filter);
    if (category) params.set('category', category);
    const qs = params.toString();
    get(`/api/alerts${qs ? `?${qs}` : ''}`)
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.data; })
      .then(d => { setAlerts(d as Alert[]); setFailed(false); })
      .catch(e => { console.error(e); setFailed(true); })
      .finally(() => setLoading(false));

    // The status-only set: on first load and when the status changes.
    if (!prev || prev.filter !== filter) {
      get(`/api/alerts${filter ? `?status=${filter}` : ''}`)
        .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.data; })
        .then(d => setStatusAlerts(d as Alert[]))
        .catch(console.error);
    }

    // The unfiltered set: on first load and after a change to alerts.
    if (!prev || prev.reloadKey !== reloadKey) {
      get('/api/alerts')
        .then(r => setAllAlerts(Array.isArray(r.data) ? (r.data as Alert[]) : null))
        .catch(() => setAllAlerts(null));
    }
  }, [filter, category, reloadKey]);

  const categoryCounts = ALL_CATEGORIES.reduce<Record<string, number>>((acc, cat) => {
    acc[cat] = statusAlerts.filter(a => categoryForType(a.alert_type) === cat).length;
    return acc;
  }, {});

  // Counts only when the unfiltered list is complete; a capped list would undercount.
  const statusCounts: Record<string, number> | null =
    allAlerts && allAlerts.length < ALERT_LIST_CAP
      ? STATUSES.reduce<Record<string, number>>((acc, s) => {
          acc[s] = s ? allAlerts.filter(a => a.status === s).length : allAlerts.length;
          return acc;
        }, {})
      : null;

  const notifySidebar = () => window.dispatchEvent(new Event('alertsChanged'));

  const updateStatus = async (id: string, status: string) => {
    await fetch('/api/alerts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status }),
    });
    setReloadKey(k => k + 1);
    notifySidebar();
  };

  const bulkUpdate = async (toStatus: string) => {
    const fromStatus = filter || 'open';
    await fetch('/api/alerts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bulk_from: fromStatus, status: toStatus, ...(category ? { category } : {}) }),
    });
    setReloadKey(k => k + 1);
    notifySidebar();
  };

  const actionableAlerts = alerts.filter(a => a.status === 'open' || a.status === 'acknowledged');
  const closedAlerts = alerts.filter(a => a.status === 'resolved' || a.status === 'dismissed');
  const showBulkActions = isAdmin && actionableAlerts.length > 1;

  const clearClosed = async () => {
    await fetch('/api/alerts', { method: 'DELETE' });
    setReloadKey(k => k + 1);
    notifySidebar();
  };

  return (
    <>
      <TopBar title="Alerts" subtitle="Security, compliance, cost and adoption alerts" />
      <PageBody>
        {/* Status switch, category picker, bulk actions */}
        <div className="flex items-center gap-3 flex-wrap min-h-[32px]">
          <Segmented<string>
            label="Status"
            value={filter}
            onChange={setFilter}
            options={STATUSES.map(s => ({
              value: s,
              label: (
                <>
                  {STATUS_LABEL[s]}
                  {statusCounts && <span className="ml-1 text-[#8F8F8F] tabular-nums">{statusCounts[s]}</span>}
                </>
              ),
            }))}
          />
          <label className="flex items-center gap-1.5 text-[13px] text-[#666666]">
            Category
            <select
              value={category}
              onChange={e => setCategory(e.target.value)}
              className={B.select}
            >
              <option value="">All categories</option>
              {ALL_CATEGORIES.map(cat => (
                <option key={cat} value={cat}>{CATEGORY_LABELS[cat]}</option>
              ))}
            </select>
          </label>

          {!loading && (showBulkActions || (isAdmin && closedAlerts.length > 0)) && (
            <div className="hidden lg:flex ml-auto items-center gap-2 text-[13px] text-[#666666]">
              {showBulkActions && (
                <>
                  <span className="tabular-nums">{actionableAlerts.length} actionable</span>
                  <button type="button" onClick={() => bulkUpdate('resolved')} className={B.secondary}>
                    Resolve all
                  </button>
                  <button type="button" onClick={() => bulkUpdate('dismissed')} className={B.secondary}>
                    Dismiss all
                  </button>
                </>
              )}
              {isAdmin && closedAlerts.length > 0 && (
                <>
                  {showBulkActions && <span className="w-px h-4 bg-[#EAEAEA]" aria-hidden="true" />}
                  <span className="tabular-nums">{closedAlerts.length} closed</span>
                  <button type="button" onClick={clearClosed} className={B.danger}>
                    Clear resolved
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Category counts */}
        <div className="flex flex-wrap gap-2">
          {ALL_CATEGORIES.map(cat => (
            <Chip key={cat} on={category === cat} onClick={() => setCategory(cat)}>
              {CATEGORY_LABELS[cat]} <span className="tabular-nums text-[#8F8F8F]">{categoryCounts[cat] ?? 0}</span>
            </Chip>
          ))}
        </div>

        {loading ? (
          <LoadingSpinner />
        ) : failed ? (
          <Notice tone="error" title="Couldn’t load this.">Try refreshing the page.</Notice>
        ) : alerts.length === 0 ? (
          <Empty title="No alerts">
            No alerts generated. The AI analysis will run when events are available.
          </Empty>
        ) : (
          <Panel flush>
            <ul className="m-0 p-0 list-none">
              {alerts.map(alert => {
                const open = expandedId === alert.id;
                const actionable = isAdmin && (alert.status === 'open' || alert.status === 'acknowledged');
                return (
                  <li key={alert.id} className="border-t border-[#F2F2F2] first:border-t-0">
                    <div className="flex gap-3.5 px-4 py-3.5 items-start">
                      <span className="w-[72px] shrink-0 pt-px">
                        <Dot color={SEVERITY_COLOR[alert.severity] ?? SEVERITY_COLOR.low}>
                          <span className="capitalize font-medium text-[#0A0A0A]">{alert.severity}</span>
                        </Dot>
                      </span>

                      <div className="flex-1 min-w-0 flex flex-col gap-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="m-0 text-[14px] font-semibold text-[#0A0A0A]">{alert.title}</h3>
                          <Pill tone={STATUS_TONE[alert.status] ?? 'neutral'}>
                            <span className="capitalize">{alert.status}</span>
                          </Pill>
                        </div>
                        <p className="m-0 text-[14px] leading-5 text-[#4D4D4D]">{alert.explanation}</p>
                        <p className="m-0 text-[13px] text-[#8F8F8F] tabular-nums">
                          {[
                            alert.user_id ? `User: ${alert.user_display_name || alert.user_id}` : null,
                            new Date(alert.generated_at * 1000).toLocaleString('en-GB'),
                            alertTypeLabel(alert.alert_type),
                            CATEGORY_LABELS[categoryForType(alert.alert_type)],
                          ].filter(Boolean).join(' · ')}
                        </p>
                        <button
                          type="button"
                          onClick={() => setExpandedId(open ? null : alert.id)}
                          aria-expanded={open}
                          className="self-start text-[13px] text-[#1F6F8B] hover:underline py-1"
                        >
                          {open ? 'Hide detail' : 'Detail'}
                        </button>
                      </div>

                      {actionable && (
                        <div className="hidden lg:flex items-center gap-1.5 shrink-0">
                          {alert.status === 'open' && (
                            <button type="button" onClick={() => updateStatus(alert.id, 'acknowledged')} className={B.secondary}>
                              Acknowledge
                            </button>
                          )}
                          <button type="button" onClick={() => updateStatus(alert.id, 'resolved')} className={B.secondary}>
                            Resolve
                          </button>
                          <button type="button" onClick={() => updateStatus(alert.id, 'dismissed')} className={`${B.secondary} !text-[#666666]`}>
                            Dismiss
                          </button>
                        </div>
                      )}
                    </div>

                    {open && alert.raw_evidence && (
                      <div className="mx-4 mb-3.5 lg:ml-[102px] px-3.5 py-3 border border-[#EAEAEA] rounded-[10px] bg-[#FAFAFA] flex flex-col gap-2">
                        {(() => {
                          try {
                            const evidence = JSON.parse(alert.raw_evidence);
                            return (
                              <>
                                {evidence.masked_value && (
                                  <div className="flex gap-2.5 items-baseline">
                                    <span className="text-[13px] text-[#666666] w-[72px] shrink-0">Detected</span>
                                    <code className="font-mono text-[13px] text-[#B42318] break-all">{evidence.masked_value}</code>
                                  </div>
                                )}
                                <div className="flex gap-2.5 items-baseline">
                                  <span className="text-[13px] text-[#666666] w-[72px] shrink-0">Evidence</span>
                                  <code className="font-mono text-[13px] text-[#4D4D4D] whitespace-pre-wrap break-all min-w-0">
                                    {JSON.stringify(evidence, null, 2)}
                                  </code>
                                </div>
                                {evidence.message_id && (
                                  <Link
                                    href={`/audit?q=${encodeURIComponent(evidence.message_id)}`}
                                    className="self-start text-[13px] font-medium text-[#1F6F8B] hover:underline"
                                  >
                                    View in Audit Log
                                  </Link>
                                )}
                              </>
                            );
                          } catch {
                            return (
                              <div className="flex gap-2.5 items-baseline">
                                <span className="text-[13px] text-[#666666] w-[72px] shrink-0">Evidence</span>
                                <code className="font-mono text-[13px] text-[#4D4D4D] whitespace-pre-wrap break-all min-w-0">{alert.raw_evidence}</code>
                              </div>
                            );
                          }
                        })()}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </Panel>
        )}
      </PageBody>
    </>
  );
}
