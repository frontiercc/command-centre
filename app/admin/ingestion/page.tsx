// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { useToast } from '@/components/shared/ToastProvider';
import IdentityConflictsCard from '@/components/admin/IdentityConflictsCard';
import CollectorConnection from '@/components/setup/CollectorConnection';
import { PageBody, Panel, Muted, T, B, C, cx } from '@/components/precision/ui';

interface OtelStatus {
  collectorTokenSet: boolean;
  collector: { address: string; token: string | null };
  lastOtelEventAt: number | null;
  otelUserCount: number;
  newUsersToday: number;
  recentOtelUsers: Array<{ id: string; display_name: string | null; email: string | null; department: string | null; last_seen_at: number | null }>;
}


export default function IngestionPage() {
  const { showToast } = useToast();

  const [otelStatus, setOtelStatus] = useState<OtelStatus | null>(null);
  const [otelLoading, setOtelLoading] = useState(true);
  const [configLoading, setConfigLoading] = useState(true);
  const [csvInput, setCsvInput] = useState('');
  const [prepopulating, setPrepopulating] = useState(false);
  const [prepopulateResult, setPrepopulateResult] = useState<{ created: number; skipped: number } | null>(null);
  const [excludedEmailsInput, setExcludedEmailsInput] = useState('');
  const [excludedEmailsSaving, setExcludedEmailsSaving] = useState(false);

  const fetchOtelStatus = () => {
    setOtelLoading(true);
    return fetch('/api/admin/otel-status')
      .then(r => r.json())
      .then((d: OtelStatus) => {
        setOtelStatus(d);
      })
      .catch(() => {})
      .finally(() => setOtelLoading(false));
  };

  useEffect(() => {
    Promise.all([
      fetchOtelStatus(),
      fetch('/api/config').then(r => r.json()).then(d => {
        if (d.otelExcludedEmails) {
          try {
            const list: string[] = JSON.parse(String(d.otelExcludedEmails));
            setExcludedEmailsInput(list.join('\n'));
          } catch { /* ignore */ }
        }
      }).catch(() => {}).finally(() => setConfigLoading(false)),
    ]);
  }, []);

  // Gate initial render on BOTH the status fetch and the config fetch, so the
  // page never flashes default/empty values (unchecked toggles, "Not set…",
  // empty exclusions) while config is still in flight. A manual "Refresh" only
  // re-runs fetchOtelStatus, which toggles otelLoading alone — configLoading
  // is already false by then, so pageLoading tracks otelLoading alone.
  const pageLoading = otelLoading || configLoading;

  // Collector status helper
  const collectorStatus = (() => {
    if (!otelStatus) return null;
    const { collectorTokenSet, lastOtelEventAt } = otelStatus;
    if (!collectorTokenSet) return 'red';
    if (!lastOtelEventAt) return 'amber';
    const ageMs = Date.now() - lastOtelEventAt * 1000;
    return ageMs < 10 * 60 * 1000 ? 'green' : 'amber';
  })();

  const handlePrepopulate = async () => {
    const lines = csvInput.trim().split('\n').filter(Boolean);
    const users = lines.map(line => {
      const [email, display_name, department] = line.split(',').map(s => s.trim());
      return { email, display_name: display_name || undefined, department: department || undefined };
    }).filter(u => u.email);

    if (users.length === 0) {
      showToast('No valid rows found. Format: email,display_name,department', 'error');
      return;
    }

    setPrepopulating(true);
    setPrepopulateResult(null);
    try {
      const res = await fetch('/api/admin/otel-prepopulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ users }),
      });
      if (!res.ok) throw new Error('Request failed');
      const result = await res.json();
      setPrepopulateResult(result);
      showToast(`Created ${result.created}, skipped ${result.skipped}`, 'success');
      if (result.created > 0) fetchOtelStatus();
    } catch {
      showToast('Failed to pre-populate users', 'error');
    } finally {
      setPrepopulating(false);
    }
  };

  const handleSaveExcludedEmails = async () => {
    setExcludedEmailsSaving(true);
    const emails = excludedEmailsInput
      .split('\n')
      .map(e => e.trim().toLowerCase())
      .filter(Boolean);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otelExcludedEmails: JSON.stringify(emails) }),
      });
      if (!res.ok) throw new Error('Request failed');
      showToast(`Saved: ${emails.length} email${emails.length === 1 ? '' : 's'} excluded`, 'success');
    } catch {
      showToast('Failed to save exclusion list', 'error');
    } finally {
      setExcludedEmailsSaving(false);
    }
  };

  return (
    <>
      <TopBar title="Ingestion" subtitle="OpenTelemetry + Enterprise API ingestion, the primary capture paths" />
      <PageBody className="max-w-[1000px]">

        {pageLoading && <LoadingSpinner />}

        {!pageLoading && (
          <>
            {/* Connect Claude: address, bearer token and settings ready to copy */}
            <Panel title="Connect Claude" subtitle="Your collector's address and bearer token, and the settings ready to copy.">
              {otelStatus?.collector ? (
                <CollectorConnection address={otelStatus.collector.address} token={otelStatus.collector.token} />
              ) : (
                <Muted>Could not load the collector details. Refresh the page to try again.</Muted>
              )}
            </Panel>

            {/* Collector Status Card */}
            <Panel
              title="Collector status"
              right={
                <button type="button" className={B.secondary} onClick={fetchOtelStatus}>
                  Refresh
                </button>
              }
            >
              <div className="flex items-start gap-3">
                <span
                  className="mt-1 h-2.5 w-2.5 rounded-full flex-shrink-0"
                  style={{ background: collectorStatus === 'green' ? C.good : collectorStatus === 'amber' ? C.medium : C.high }}
                />
                <div className="min-w-0">
                  <p className={cx('m-0 text-[14px] font-semibold',
                    collectorStatus === 'green' ? 'text-[#1A7F37]' :
                    collectorStatus === 'amber' ? 'text-[#B54708]' :
                    'text-[#B42318]')}>
                    {collectorStatus === 'green' ? 'Collector active, OTel events flowing' :
                     collectorStatus === 'amber' ? (otelStatus?.lastOtelEventAt ? 'Collector token set, no recent events' : 'Awaiting first OTel event') :
                     'Collector token not configured'}
                  </p>
                  <p className="m-0 mt-0.5 text-[13px] text-[#8F8F8F] tabular-nums">
                    {otelStatus?.otelUserCount ?? 0} OTel users &middot; {otelStatus?.newUsersToday ?? 0} new today
                    {otelStatus?.lastOtelEventAt ? ` · Last event ${new Date(otelStatus.lastOtelEventAt * 1000).toLocaleString()}` : ''}
                  </p>
                </div>
              </div>
            </Panel>

            <IdentityConflictsCard />

            {/* Recent OTel Users */}
            <Panel title="Recent OTel users" flush>
              {(otelStatus?.recentOtelUsers ?? []).length === 0 ? (
                <div className="p-4"><Muted>No OTel users yet.</Muted></div>
              ) : (
                <div className="overflow-x-auto">
                  <table className={T.table}>
                    <thead>
                      <tr className={T.headRow}>
                        <th className={T.th}>Name</th>
                        <th className={T.th}>Email</th>
                        <th className={T.th}>Department</th>
                        <th className={T.th}>Last seen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {otelStatus!.recentOtelUsers.map(u => (
                        <tr key={u.id} className={T.row}>
                          <td className={T.td}>{u.display_name || '—'}</td>
                          <td className={cx(T.tdMute, 'font-mono text-[13px]')}>{u.email || '—'}</td>
                          <td className={T.tdMute}>{u.department || '—'}</td>
                          <td className={cx(T.tdMute, 'tabular-nums whitespace-nowrap')}>
                            {u.last_seen_at ? new Date(u.last_seen_at * 1000).toLocaleString() : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            {/* Pre-populate Users */}
            <Panel title="Pre-populate OTel users">
              <div className="flex flex-col gap-3">
                <label htmlFor="otel-prepopulate" className="text-[13px] text-[#666666] leading-5">
                  Paste a CSV list of users (one per line: <code className="text-[12px] font-mono bg-[#F2F2F2] px-1 rounded-[6px]">email,display_name,department</code>).
                  Rows where the email already exists are skipped.
                </label>
                <textarea
                  id="otel-prepopulate"
                  value={csvInput}
                  onChange={e => setCsvInput(e.target.value)}
                  rows={6}
                  placeholder={`alice@example.com,Alice Smith,Engineering\nbob@example.com,Bob Jones,Design`}
                  className={cx(B.input, 'w-full font-mono resize-y')}
                />
                <div className="flex items-center gap-3 flex-wrap">
                  <button
                    type="button"
                    onClick={handlePrepopulate}
                    disabled={prepopulating || !csvInput.trim()}
                    className={B.primary}
                  >
                    {prepopulating ? 'Importing...' : 'Import users'}
                  </button>
                  {prepopulateResult && (
                    <span className="text-[13px] text-[#666666] tabular-nums">
                      Created <strong className="text-[#0A0A0A]">{prepopulateResult.created}</strong>, skipped <strong className="text-[#0A0A0A]">{prepopulateResult.skipped}</strong>
                    </span>
                  )}
                </div>
              </div>
            </Panel>

            {/* Exclude OTel Users */}
            <Panel title="Exclude users from OTel monitoring">
              <div className="flex flex-col gap-3">
                <label htmlFor="otel-excluded" className="text-[13px] text-[#666666] leading-5">
                  OTel events arriving for these email addresses will be silently dropped: no data written, no alerts fired.
                  Use this for executives, risk teams, or other roles that should not be monitored.
                  One email address per line.
                </label>
                <textarea
                  id="otel-excluded"
                  value={excludedEmailsInput}
                  onChange={e => setExcludedEmailsInput(e.target.value)}
                  rows={5}
                  placeholder={`ceo@example.com\ncto@example.com\nrisk.team@example.com`}
                  className={cx(B.input, 'w-full font-mono resize-y')}
                />
                <div>
                  <button
                    type="button"
                    onClick={handleSaveExcludedEmails}
                    disabled={excludedEmailsSaving}
                    className={B.primary}
                  >
                    {excludedEmailsSaving ? 'Saving…' : 'Save exclusion list'}
                  </button>
                </div>
              </div>
            </Panel>
          </>
        )}

      </PageBody>
    </>
  );
}
