// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0
// Some icon drawings in this file are from Heroicons (MIT); see THIRD-PARTY-NOTICES.md.

'use client';

import { useEffect, useState } from 'react';
import TopBar from '@/components/layout/TopBar';
import { PageBody, Panel, Notice, B, cx } from '@/components/precision/ui';
import { ToggleRow, Field, Modal } from '@/components/admin/precision-admin';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { useToast } from '@/components/shared/ToastProvider';
import SecretRemoveButton from '@/components/admin/SecretRemoveButton';

export default function AdminDataPage() {
  // Export state
  const [exportDateFrom, setExportDateFrom] = useState('');
  const [exportDateTo, setExportDateTo] = useState('');
  const [exportSurface, setExportSurface] = useState('all');
  const [exporting, setExporting] = useState(false);

  // Retention state
  const [retentionCoworkDays, setRetentionCoworkDays] = useState('90');
  const [retentionCodeDays, setRetentionCodeDays] = useState('90');
  const [retentionOtelDays, setRetentionOtelDays] = useState('30');
  const [retentionComplianceDays, setRetentionComplianceDays] = useState('365');
  const [retentionChatDays, setRetentionChatDays] = useState('90');
  const [retentionErrorDays, setRetentionErrorDays] = useState('90');
  const [retentionAlertsDays, setRetentionAlertsDays] = useState('90');
  const [retentionAnalyticsDays, setRetentionAnalyticsDays] = useState('365');
  const [retentionMode, setRetentionMode] = useState<'strip' | 'purge'>('strip');
  const [cleanupRunning, setCleanupRunning] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<Record<string, unknown> | null>(null);

  // Archive state
  const [archiveEnabled, setArchiveEnabled] = useState(false);
  const [archiveProvider, setArchiveProvider] = useState('');
  const [archiveBucket, setArchiveBucket] = useState('');
  const [archiveRegion, setArchiveRegion] = useState('');
  const [archiveAccessKeyId, setArchiveAccessKeyId] = useState('');
  const [archiveSecretAccessKey, setArchiveSecretAccessKey] = useState('');
  const [archiveTestResult, setArchiveTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [archiveTesting, setArchiveTesting] = useState(false);
  const [archiveSaving, setArchiveSaving] = useState(false);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { showToast } = useToast();

  // Danger zone — clear Audit Log + Alerts
  const [showClearModal, setShowClearModal] = useState(false);
  const [clearConfirm, setClearConfirm] = useState('');
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch('/api/config').then(r => r.json()),
      fetch('/api/archive/config').then(r => r.json()),
    ])
      .then(([configData, archiveData]) => {
        if (configData.retentionCoworkDays) setRetentionCoworkDays(String(configData.retentionCoworkDays));
        if (configData.retentionCodeDays) setRetentionCodeDays(String(configData.retentionCodeDays));
        if (configData.retentionOtelDays) setRetentionOtelDays(String(configData.retentionOtelDays));
        if (configData.retentionComplianceDays) setRetentionComplianceDays(String(configData.retentionComplianceDays));
        if (configData.retentionChatDays) setRetentionChatDays(String(configData.retentionChatDays));
        if (configData.retentionErrorDays) setRetentionErrorDays(String(configData.retentionErrorDays));
        if (configData.retentionAlertsDays) setRetentionAlertsDays(String(configData.retentionAlertsDays));
        if (configData.retentionAnalyticsDays) setRetentionAnalyticsDays(String(configData.retentionAnalyticsDays));
        if (configData.retentionMode) setRetentionMode(configData.retentionMode);

        setArchiveEnabled(archiveData.archiveEnabled || false);
        setArchiveProvider(archiveData.archiveProvider || '');
        setArchiveBucket(archiveData.archiveBucket || '');
        setArchiveRegion(archiveData.archiveRegion || '');
        setArchiveAccessKeyId(archiveData.archiveAccessKeyId || '');
        setArchiveSecretAccessKey(archiveData.archiveSecretAccessKey || '');
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const handleSaveRetention = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          retentionCoworkDays,
          retentionCodeDays,
          retentionOtelDays,
          retentionComplianceDays,
          retentionChatDays,
          retentionErrorDays,
          retentionAlertsDays,
          retentionAnalyticsDays,
          retentionMode,
        }),
      });
      if (res.ok) {
        showToast('Retention settings saved', 'success');
      } else {
        const data = await res.json();
        showToast(data.error || 'Failed to save retention settings', 'error');
      }
    } catch {
      showToast('Failed to save retention settings', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return (
    <>
      <TopBar title="Data" subtitle="Retention policies and cloud archive" />
      <LoadingSpinner />
    </>
  );

  return (
    <>
      <TopBar title="Data" subtitle="Retention policies and cloud archive" />
      <PageBody className="max-w-[960px]">

        {/* Export data */}
        <Panel
          title="Export data"
          subtitle="Download audit log data as CSV for any date range. Includes all surfaces unless filtered."
          flush
        >
          <div className="px-4 py-3 grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Field label="From">
              <input
                type="date"
                value={exportDateFrom}
                onChange={e => setExportDateFrom(e.target.value)}
                className={cx(B.input, 'w-full')}
              />
            </Field>
            <Field label="To">
              <input
                type="date"
                value={exportDateTo}
                onChange={e => setExportDateTo(e.target.value)}
                className={cx(B.input, 'w-full')}
              />
            </Field>
            <Field label="Surface">
              <select
                value={exportSurface}
                onChange={e => setExportSurface(e.target.value)}
                className={cx(B.select, 'w-full text-[14px]')}
              >
                <option value="all">All surfaces</option>
                <option value="code">Code</option>
                <option value="cowork">Cowork</option>
                <option value="chat">Chat</option>
              </select>
            </Field>
          </div>
          <div className="px-4 py-3 border-t border-[#F2F2F2] flex items-center gap-3 flex-wrap">
            <button
              type="button"
              onClick={async () => {
                setExporting(true);
                try {
                  const p = new URLSearchParams({ surface: exportSurface });
                  if (exportDateFrom) p.set('dateFrom', String(Math.floor(new Date(exportDateFrom).getTime() / 1000)));
                  if (exportDateTo) p.set('dateTo', String(Math.floor(new Date(exportDateTo + 'T23:59:59').getTime() / 1000)));
                  const res = await fetch(`/api/admin/export?${p}`);
                  if (!res.ok) { showToast('Export failed', 'error'); return; }
                  const blob = await res.blob();
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `ccc-audit-export-${new Date().toISOString().split('T')[0]}.csv`;
                  a.click();
                  URL.revokeObjectURL(url);
                } catch {
                  showToast('Export failed', 'error');
                } finally {
                  setExporting(false);
                }
              }}
              disabled={exporting}
              className={B.primary}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              {exporting ? 'Exporting...' : 'Download CSV'}
            </button>
            <span className="text-[13px] text-[#8F8F8F]">Leave dates empty to export all data. Large exports may take a few seconds.</span>
          </div>
        </Panel>

        {/* Data retention */}
        <Panel
          title="Data retention"
          subtitle="Configure how long content is retained before cleanup. Minimum 7 days."
          flush
        >
          <div className="px-4 py-3 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
            <Field label="Cowork content retention (days)">
              <input
                type="number"
                min={7}
                value={retentionCoworkDays}
                onChange={(e) => setRetentionCoworkDays(e.target.value)}
                className={cx(B.input, 'w-32')}
              />
            </Field>

            <Field
              label="Code retention (days)"
              hint="Code prompts, session metrics, and classifications. Code holds no assistant output, only your prompts and metadata."
            >
              <input
                type="number"
                min={7}
                value={retentionCodeDays}
                onChange={(e) => setRetentionCodeDays(e.target.value)}
                className={cx(B.input, 'w-32')}
              />
            </Field>

            <Field label="OTel events retention (days)">
              <input
                type="number"
                min={7}
                value={retentionOtelDays}
                onChange={(e) => setRetentionOtelDays(e.target.value)}
                className={cx(B.input, 'w-32')}
              />
            </Field>

            <Field label="Compliance events retention (days)">
              <input
                type="number"
                min={7}
                value={retentionComplianceDays}
                onChange={(e) => setRetentionComplianceDays(e.target.value)}
                className={cx(B.input, 'w-32')}
              />
            </Field>

            <Field
              label="Chat retention (days)"
              hint="Covers Compliance-API-synced chat prompts (chat_messages) and assistant metadata (chat_assistant_meta)."
            >
              <input
                type="number"
                min={7}
                value={retentionChatDays}
                onChange={(e) => setRetentionChatDays(e.target.value)}
                className={cx(B.input, 'w-32')}
              />
            </Field>

            <Field
              label="Error events retention (days)"
              hint="Error/diagnostic events older than this are stripped or purged."
            >
              <input
                type="number"
                min={7}
                value={retentionErrorDays}
                onChange={(e) => setRetentionErrorDays(e.target.value)}
                className={cx(B.input, 'w-32')}
              />
            </Field>

            <Field
              label="Alerts retention (days)"
              hint="Resolved and dismissed alerts older than this are deleted. Open alerts are always kept."
            >
              <input
                type="number"
                min={7}
                value={retentionAlertsDays}
                onChange={(e) => setRetentionAlertsDays(e.target.value)}
                className={cx(B.input, 'w-32')}
              />
            </Field>

            <Field
              label="Adoption analytics retention (days)"
              hint="Per-user daily engagement snapshots older than this are deleted."
            >
              <input
                type="number"
                min={7}
                value={retentionAnalyticsDays}
                onChange={(e) => setRetentionAnalyticsDays(e.target.value)}
                className={cx(B.input, 'w-32')}
              />
            </Field>
          </div>

          <fieldset className="px-4 py-3 border-t border-[#F2F2F2] m-0 min-w-0">
            <legend className="sr-only">Retention mode</legend>
            <span aria-hidden="true" className="block text-[14px] font-medium text-[#0A0A0A] mb-2">Retention mode</span>
            <div className="flex flex-col sm:flex-row gap-2 sm:gap-6">
              <label className="flex items-center gap-2 text-[14px] text-[#0A0A0A]">
                <input
                  type="radio"
                  name="retentionMode"
                  value="strip"
                  checked={retentionMode === 'strip'}
                  onChange={() => setRetentionMode('strip')}
                  className="accent-[#0A0A0A]"
                />
                Strip content (keep metadata)
              </label>
              <label className="flex items-center gap-2 text-[14px] text-[#0A0A0A]">
                <input
                  type="radio"
                  name="retentionMode"
                  value="purge"
                  checked={retentionMode === 'purge'}
                  onChange={() => setRetentionMode('purge')}
                  className="accent-[#0A0A0A]"
                />
                Full purge (delete rows)
              </label>
            </div>
          </fieldset>

          <div className="px-4 py-3 border-t border-[#F2F2F2] flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={handleSaveRetention}
              disabled={saving}
              className={B.primary}
            >
              {saving ? 'Saving...' : 'Save retention settings'}
            </button>

            <button
              type="button"
              onClick={async () => {
                setCleanupRunning(true);
                setCleanupResult(null);
                try {
                  const res = await fetch('/api/retention/run', { method: 'POST' });
                  const data = await res.json();
                  setCleanupResult(data);
                } catch {
                  setCleanupResult({ error: 'Cleanup failed' });
                } finally {
                  setCleanupRunning(false);
                }
              }}
              disabled={cleanupRunning}
              className={B.danger}
            >
              {cleanupRunning
                ? (archiveEnabled ? 'Archiving and cleaning up...' : 'Running...')
                : archiveEnabled ? 'Archive and clean up now' : 'Run cleanup now'}
            </button>
          </div>

          {cleanupResult ? (
            <div className="px-4 pb-3 flex flex-col gap-2">
              {Boolean(cleanupResult?.archived) && (() => {
                const a = cleanupResult!.archived as { cowork_rows: number; otel_rows: number; compliance_rows: number; destination: string };
                return (
                  <p className="m-0 text-[14px] text-[#1A7F37]">
                    Archived {a.cowork_rows + a.otel_rows + a.compliance_rows} rows to {a.destination}
                  </p>
                );
              })()}

              {Boolean(cleanupResult?.archive_error) && (
                <p className="m-0 text-[14px] text-[#B42318]">
                  Archive failed: {String(cleanupResult!.archive_error)}. Cleanup was not performed.
                </p>
              )}

              {cleanupResult && !('error' in cleanupResult) && !cleanupResult.archive_error && (
                <Notice tone="success">
                  Cleanup complete ({String(cleanupResult.mode)}):
                  cowork={String(cleanupResult.cowork_rows_affected)},
                  code={String(cleanupResult.code_rows_affected)},
                  otel={String(cleanupResult.otel_rows_affected)},
                  compliance={String(cleanupResult.compliance_rows_affected)},
                  alerts={String(cleanupResult.alerts_rows_affected)},
                  analytics={String(cleanupResult.analytics_rows_affected)}
                  in {String(cleanupResult.duration_ms)}ms
                </Notice>
              )}

              {cleanupResult && 'error' in cleanupResult && (
                <Notice tone="error">
                  {String(cleanupResult.error)}
                </Notice>
              )}
            </div>
          ) : null}
        </Panel>

        {/* Cloud archive */}
        <Panel
          title="Cloud archive"
          subtitle="Archives cowork, OTel, compliance, chat and error rows to cloud storage before retention cleanup runs."
          flush
        >
          <ToggleRow
            first
            label="Enable archive before cleanup"
            checked={archiveEnabled}
            onChange={(next) => setArchiveEnabled(next)}
          />

          {archiveEnabled && (
            <>
              <div className="px-4 py-3 border-t border-[#F2F2F2] grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
                <Field label="Provider">
                  <select
                    value={archiveProvider}
                    onChange={(e) => setArchiveProvider(e.target.value)}
                    className={cx(B.select, 'w-full text-[14px]')}
                  >
                    <option value="">Select provider...</option>
                    <option value="s3">Amazon S3</option>
                  </select>
                </Field>

                {archiveProvider === 's3' && (
                  <>
                    <Field label="Bucket">
                      <input
                        type="text"
                        value={archiveBucket}
                        onChange={(e) => setArchiveBucket(e.target.value)}
                        placeholder="my-ccc-archive-bucket"
                        className={cx(B.input, 'w-full')}
                      />
                    </Field>
                    <Field label="Region">
                      <input
                        type="text"
                        value={archiveRegion}
                        onChange={(e) => setArchiveRegion(e.target.value)}
                        placeholder="us-east-1"
                        className={cx(B.input, 'w-full')}
                      />
                    </Field>
                    {/* Secret fields: a plain div (not Field's wrapping <label>) so the Remove button is not inside the label. */}
                    <div className="flex flex-col gap-1.5 min-w-0 md:col-start-1">
                      <label htmlFor="archive-access-key-id" className="text-[14px] font-medium text-[#0A0A0A]">Access key ID</label>
                      <div className="flex gap-2">
                        <input
                          id="archive-access-key-id"
                          type="text"
                          value={archiveAccessKeyId}
                          onChange={(e) => setArchiveAccessKeyId(e.target.value)}
                          className={cx(B.input, 'w-full min-w-0 font-mono')}
                        />
                        <SecretRemoveButton
                          configKey="archiveAccessKeyId"
                          label="Archive access key ID"
                          hasValue={archiveAccessKeyId.length > 0}
                          onRemoved={() => setArchiveAccessKeyId('')}
                        />
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5 min-w-0">
                      <label htmlFor="archive-secret-access-key" className="text-[14px] font-medium text-[#0A0A0A]">Secret access key</label>
                      <div className="flex gap-2">
                        <input
                          id="archive-secret-access-key"
                          type="password"
                          value={archiveSecretAccessKey}
                          onChange={(e) => setArchiveSecretAccessKey(e.target.value)}
                          className={cx(B.input, 'w-full min-w-0 font-mono')}
                        />
                        <SecretRemoveButton
                          configKey="archiveSecretAccessKey"
                          label="Archive secret access key"
                          hasValue={archiveSecretAccessKey.length > 0}
                          onRemoved={() => setArchiveSecretAccessKey('')}
                        />
                      </div>
                    </div>
                  </>
                )}
              </div>

              <div className="px-4 py-3 border-t border-[#F2F2F2] flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={async () => {
                    setArchiveTesting(true);
                    setArchiveTestResult(null);
                    try {
                      const res = await fetch('/api/archive/test', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          provider: archiveProvider,
                          bucket: archiveBucket,
                          region: archiveRegion,
                          accessKeyId: archiveAccessKeyId,
                          secretAccessKey: archiveSecretAccessKey,
                        }),
                      });
                      const data = await res.json();
                      setArchiveTestResult(data);
                    } catch {
                      setArchiveTestResult({ ok: false, error: 'Connection failed' });
                    } finally {
                      setArchiveTesting(false);
                    }
                  }}
                  disabled={archiveTesting || !archiveProvider}
                  className={B.secondary}
                >
                  {archiveTesting ? 'Testing...' : 'Test connection'}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    setArchiveSaving(true);
                    try {
                      const res = await fetch('/api/archive/config', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          archiveEnabled: String(archiveEnabled),
                          archiveProvider,
                          archiveBucket,
                          archiveRegion,
                          archiveAccessKeyId,
                          archiveSecretAccessKey,
                        }),
                      });
                      if (res.ok) {
                        showToast('Archive settings saved', 'success');
                      } else {
                        showToast("Couldn't save archive settings. Try again.", 'error');
                      }
                    } catch {
                      showToast("Couldn't save archive settings. Try again.", 'error');
                    } finally {
                      setArchiveSaving(false);
                    }
                  }}
                  disabled={archiveSaving}
                  className={B.primary}
                >
                  {archiveSaving ? 'Saving...' : 'Save archive settings'}
                </button>

                {archiveTestResult && (
                  <span className={cx('text-[13px]', archiveTestResult.ok ? 'text-[#1A7F37]' : 'text-[#B42318]')}>
                    {archiveTestResult.ok ? 'Connection successful' : `Error: ${archiveTestResult.error}`}
                  </span>
                )}
              </div>
            </>
          )}
        </Panel>

        {/* Danger zone: clear Audit Log and Alerts */}
        <Panel
          title={<span className="text-[#B42318]">Danger zone</span>}
          right={
            <button
              type="button"
              onClick={() => { setClearConfirm(''); setShowClearModal(true); }}
              className={B.danger}
            >
              Clear Audit Log &amp; Alerts…
            </button>
          }
        >
          <p className="m-0 text-[14px] text-[#333333]">
            Permanently wipe the <strong>Audit Log</strong> and <strong>Alerts</strong>. This cannot be undone.
          </p>
          <p className="mt-1.5 mb-0 text-[13px] text-[#666666] leading-5">
            Clears the audit event feed (Cowork, Code &amp; Chat messages, skill/connector events) and all alerts.
            <strong> Keeps</strong> the security/compliance audit trail, accounts, config and settings. Note: Code &amp;
            Work Pulse recompute to empty afterward (they derive from the same events).
          </p>
        </Panel>

        {showClearModal && (
          <Modal labelledBy="clear-data-title">
            <div className="px-5 py-4 border-b border-[#EAEAEA]">
              <h3 id="clear-data-title" className="m-0 text-[15px] font-semibold text-[#B42318]">Clear Audit Log &amp; Alerts?</h3>
            </div>
            <div className="px-5 py-4 flex flex-col gap-3">
              <div>
                <p className="m-0 mb-1.5 text-[14px] text-[#333333]">This permanently deletes:</p>
                <ul className="m-0 text-[13px] text-[#4D4D4D] list-disc pl-5 space-y-0.5">
                  <li>The Audit Log event feed: Cowork, Code &amp; Chat messages, skill/connector events</li>
                  <li>All alerts</li>
                </ul>
              </div>
              <p className="m-0 text-[13px] text-[#666666] leading-5">
                <strong>Keeps</strong> the security/compliance audit trail, accounts, config and settings. Code/Cowork
                Pulse will recompute to empty (same source data). <strong className="text-[#B42318]">This cannot be undone.</strong>
              </p>
              <Field label={<span className="text-[13px]">Type <span className="font-mono font-semibold">DELETE</span> to confirm</span>}>
                <input
                  value={clearConfirm}
                  onChange={e => setClearConfirm(e.target.value)}
                  placeholder="DELETE"
                  className={cx(B.input, 'w-full focus:ring-[#B42318]/30 focus:border-[#B42318]')}
                />
              </Field>
            </div>
            <div className="px-5 py-3 border-t border-[#EAEAEA] flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowClearModal(false)}
                disabled={clearing}
                className={B.secondary}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  setClearing(true);
                  try {
                    const res = await fetch('/api/admin/clear-data', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ confirm: clearConfirm }),
                    });
                    const d = await res.json();
                    if (!res.ok) throw new Error(d.message || d.error || 'Failed to clear');
                    showToast(`Cleared ${d.total} ${d.total === 1 ? 'record' : 'records'}. Audit Log & Alerts wiped`, 'success');
                    setShowClearModal(false);
                  } catch (err) {
                    showToast(err instanceof Error ? err.message : 'Failed to clear', 'error');
                  } finally {
                    setClearing(false);
                  }
                }}
                disabled={clearing || clearConfirm !== 'DELETE'}
                className={B.danger}
              >
                {clearing ? 'Clearing…' : 'Permanently clear'}
              </button>
            </div>
          </Modal>
        )}

      </PageBody>
    </>
  );
}
