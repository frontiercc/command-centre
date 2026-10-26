// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState, useCallback } from 'react';
import TopBar from '@/components/layout/TopBar';
import { PageBody, Toolbar, Panel, PanelFoot, T, Tag, Pill, B, Empty, Muted, cx } from '@/components/precision/ui';

interface AuditRow {
  id: number;
  actor_id: string;
  actor_email: string;
  actor_ip: string | null;
  resource: string;
  action: string;
  outcome: string;
  detail: string | null;
  occurred_at: number;
}

export default function AccessAuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [actorEmail, setActorEmail] = useState('');
  const [resource, setResource] = useState('');
  const [action, setAction] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const fetchLogs = useCallback(() => {
    const p = new URLSearchParams();
    if (actorEmail) p.set('actorEmail', actorEmail);
    if (resource)   p.set('resource', resource);
    if (action)     p.set('action', action);
    if (dateFrom)   p.set('dateFrom', String(Math.floor(new Date(dateFrom).getTime() / 1000)));
    if (dateTo)     p.set('dateTo', String(Math.floor(new Date(dateTo).getTime() / 1000)));
    setLoading(true);
    fetch(`/api/access-audit?${p}`)
      .then(r => r.json())
      .then(setRows)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [actorEmail, resource, action, dateFrom, dateTo]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  const exportCsv = () => {
    const p = new URLSearchParams();
    if (actorEmail) p.set('actorEmail', actorEmail);
    if (resource)   p.set('resource', resource);
    if (action)     p.set('action', action);
    if (dateFrom)   p.set('dateFrom', String(Math.floor(new Date(dateFrom).getTime() / 1000)));
    if (dateTo)     p.set('dateTo', String(Math.floor(new Date(dateTo).getTime() / 1000)));
    p.set('format', 'csv');
    window.location.href = `/api/access-audit?${p}`;
  };

  return (
    <>
      <TopBar title="Access Audit Log" subtitle="Immutable record of admin data access: who accessed what and when (SOC2)" />
      <PageBody>

        {/* Filters */}
        <Toolbar>
          <input
            type="text"
            value={actorEmail}
            onChange={e => setActorEmail(e.target.value)}
            placeholder="Filter by email..."
            aria-label="Filter by email"
            className={cx(B.input, 'w-full sm:w-52')}
          />
          <select
            value={resource}
            onChange={e => setResource(e.target.value)}
            aria-label="Resource"
            className={B.select}
          >
            <option value="">All resources</option>
            <option value="dashboard">Dashboard</option>
            <option value="events">Events</option>
            <option value="alerts">Alerts</option>
            <option value="reports">Reports</option>
            <option value="admin/users">Admin users</option>
            <option value="users">Users (GDPR/LGPD erasure)</option>
            <option value="ai/briefing">AI briefing</option>
            <option value="auth">Auth (SSO)</option>
            <option value="config">Config</option>
            <option value="config/*">Config (all keys)</option>
            <option value="finance/chargeback">FinOps: Chargeback</option>
            <option value="finance/cost-centres">FinOps: Cost centres</option>
            <option value="finance/model-efficiency">FinOps: Model efficiency</option>
            <option value="highlights">Weekly Highlights</option>
            <option value="library">S&amp;C Board</option>
          </select>
          <select
            value={action}
            onChange={e => setAction(e.target.value)}
            aria-label="Action"
            className={B.select}
          >
            <option value="">All actions</option>
            <option value="READ">READ</option>
            <option value="WRITE">WRITE</option>
            <option value="DELETE">DELETE</option>
            <option value="EXPORT">EXPORT</option>
          </select>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
            aria-label="From date" className={B.select} />
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
            aria-label="To date" className={B.select} />
          <button type="button" onClick={fetchLogs} className={B.primary}>
            Refresh
          </button>
          <button type="button" onClick={exportCsv} className={B.secondary}>
            Export CSV
          </button>
        </Toolbar>

        {loading ? (
          <Muted>Loading...</Muted>
        ) : rows.length === 0 ? (
          <Empty title="No access log entries found for these filters." />
        ) : (
          <Panel title="Access log" flush>
            <div className="overflow-x-auto">
              <table className={T.table}>
                <thead>
                  <tr className={T.headRow}>
                    <th scope="col" className={T.th}>Time</th>
                    <th scope="col" className={T.th}>Actor</th>
                    <th scope="col" className={T.th}>IP</th>
                    <th scope="col" className={T.th}>Resource</th>
                    <th scope="col" className={T.th}>Action</th>
                    <th scope="col" className={T.th}>Outcome</th>
                    <th scope="col" className={T.th}>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => (
                    <tr key={row.id} className={T.row}>
                      <td className={cx(T.tdMute, 'whitespace-nowrap text-[13px] tabular-nums')}>
                        {new Date(row.occurred_at * 1000).toLocaleString('en-GB')}
                      </td>
                      <td className={cx(T.td, 'text-[#0A0A0A]')}>{row.actor_email}</td>
                      <td className={cx(T.td, 'text-[13px] font-mono text-[#8F8F8F]')}>{row.actor_ip ?? '—'}</td>
                      <td className={cx(T.td, 'text-[#333333]')}>{row.resource}</td>
                      <td className={T.td}>
                        <Tag tone={
                          row.action === 'READ'   ? 'measured' :
                          row.action === 'WRITE'  ? 'warn'     :
                          row.action === 'DELETE' ? 'bad'      :
                          'neutral'
                        }>{row.action}</Tag>
                      </td>
                      <td className={T.td}>
                        <Pill tone={
                          row.outcome === 'success' ? 'good' :
                          row.outcome === 'denied'  ? 'bad'  : 'warn'
                        }>{row.outcome}</Pill>
                      </td>
                      <td className={cx(T.td, 'text-[13px] text-[#8F8F8F] truncate max-w-xs')} title={row.detail ?? ''}>
                        {row.detail ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <PanelFoot>
              {rows.length} {rows.length === 500 ? '(limit reached: use filters or export CSV for full history)' : 'entries'}
            </PanelFoot>
          </Panel>
        )}
      </PageBody>
    </>
  );
}
