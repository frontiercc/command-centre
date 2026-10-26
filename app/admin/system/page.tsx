// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { useToast } from '@/components/shared/ToastProvider';
import SecretRemoveButton from '@/components/admin/SecretRemoveButton';
import HighlightsCard from '@/components/admin/HighlightsCard';
import SystemHealthCard from '@/components/admin/SystemHealthCard';
import { PageBody, Panel, SubHead, Figure, Pill, Notice, Muted, T, B, cx } from '@/components/precision/ui';
import { ToggleRow, Field } from '@/components/admin/precision-admin';
import packageJson from '@/package.json';

const REPO_URL = 'https://github.com/frontiercc/command-centre';

const MODEL_FAMILIES = ['haiku', 'sonnet', 'opus'] as const;

function ModelSelect({
  value, onChange, models, loading,
}: {
  value: string;
  onChange: (v: string) => void;
  models: { id: string; display_name: string }[];
  loading: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cx(B.select, 'w-full max-w-md')}
    >
      {loading && (
        <>
          <option value={value}>{value}</option>
          <option disabled value="">Loading models…</option>
        </>
      )}
      {!loading && models.length === 0 && <option value={value}>{value}</option>}
      {!loading && models.length > 0 && (
        <>
          {MODEL_FAMILIES.map((family) => {
            const group = models.filter((m) => m.id.toLowerCase().includes(family));
            if (!group.length) return null;
            return (
              <optgroup key={family} label={family.charAt(0).toUpperCase() + family.slice(1)}>
                {group.map((m) => (
                  <option key={m.id} value={m.id}>{m.display_name || m.id}</option>
                ))}
              </optgroup>
            );
          })}
          {(() => {
            const other = models.filter((m) => !MODEL_FAMILIES.some((f) => m.id.toLowerCase().includes(f)));
            if (!other.length) return null;
            return (
              <optgroup label="Other">
                {other.map((m) => (
                  <option key={m.id} value={m.id}>{m.display_name || m.id}</option>
                ))}
              </optgroup>
            );
          })()}
        </>
      )}
    </select>
  );
}

type CheckStatus = 'idle' | 'running' | 'pass' | 'fail' | 'info';

interface DiagCheck {
  name: string;
  endpoint: string;
  status: CheckStatus;
  ms: number | null;
  detail: string;
  /** Custom check logic — when present, the runner calls this instead of generically fetching `endpoint`. */
  run?: () => Promise<{ status: CheckStatus; ms: number | null; detail: string }>;
}

function timeAgo(ts: number): string {
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

async function runOtelIngestionCheck(): Promise<{ status: CheckStatus; ms: number | null; detail: string }> {
  const start = performance.now();
  try {
    const res = await fetch('/api/db/stats');
    const ms = Math.round(performance.now() - start);
    if (!res.ok) return { status: 'fail', ms, detail: `HTTP ${res.status}` };
    const data = await res.json();
    const latest = data.latestOtelEventAt;
    if (latest === null || latest === undefined) {
      return { status: 'info', ms, detail: 'No OTel data yet' };
    }
    const ageSeconds = Math.floor(Date.now() / 1000) - Number(latest);
    if (ageSeconds <= 86400) {
      return { status: 'pass', ms, detail: `last event ${timeAgo(Number(latest))}` };
    }
    return { status: 'fail', ms, detail: `Stale: last event ${timeAgo(Number(latest))}` };
  } catch (err) {
    return { status: 'fail', ms: null, detail: err instanceof Error ? err.message : 'Network error' };
  }
}

function makeApiKeyCheck(configKey: 'complianceAccessKey' | 'anthropicAnalyticsApiKey' | 'anthropicAdminApiKey') {
  return async (): Promise<{ status: CheckStatus; ms: number | null; detail: string }> => {
    const start = performance.now();
    try {
      const configRes = await fetch('/api/config');
      if (!configRes.ok) return { status: 'fail', ms: Math.round(performance.now() - start), detail: `HTTP ${configRes.status}` };
      const configData = await configRes.json();
      if (!configData[configKey]) {
        return { status: 'info', ms: null, detail: 'Not configured' };
      }
      const res = await fetch('/api/config/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: configKey }),
      });
      const ms = Math.round(performance.now() - start);
      const data = await res.json();
      if (data.ok) return { status: 'pass', ms, detail: 'Key valid' };
      return { status: 'fail', ms, detail: data.error || 'Key test failed' };
    } catch (err) {
      return { status: 'fail', ms: null, detail: err instanceof Error ? err.message : 'Network error' };
    }
  };
}

const INITIAL_CHECKS: DiagCheck[] = [
  { name: 'Hub health', endpoint: '/api/health', status: 'idle', ms: null, detail: '' },
  { name: 'Data pipeline', endpoint: '/api/dashboard', status: 'idle', ms: null, detail: '' },
  { name: 'Database stats', endpoint: '/api/db/stats', status: 'idle', ms: null, detail: '' },
  { name: 'OTel ingestion', endpoint: '#otel-ingestion', status: 'idle', ms: null, detail: '', run: runOtelIngestionCheck },
  { name: 'Compliance API key', endpoint: '#compliance-api-key', status: 'idle', ms: null, detail: '', run: makeApiKeyCheck('complianceAccessKey') },
  { name: 'Analytics API key', endpoint: '#analytics-api-key', status: 'idle', ms: null, detail: '', run: makeApiKeyCheck('anthropicAnalyticsApiKey') },
  { name: 'Admin API key', endpoint: '#admin-api-key', status: 'idle', ms: null, detail: '', run: makeApiKeyCheck('anthropicAdminApiKey') },
];

interface DigestConfig {
  digestEnabled: boolean;
  digestSendHourUtc: number;
  digestRecipients: string;
  digestSlackWebhookUrl: string;
  digestHubUrl: string;
  digestLastSentWeek: string | null;
  nextSendPreview: string;
  channels: { email: boolean; slack: boolean };
}

interface DigestTestResult {
  email: 'sent' | 'skipped' | 'failed';
  slack: 'sent' | 'skipped' | 'failed';
  errors: string[];
  isSample: boolean;
}

interface ConnectorToken {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

interface ConnectorEndpoints {
  mcp: string;
  exportSummary: string;
  exportTrends: string;
  exportHealth: string;
}

export default function SystemPage() {
  const [organisationName, setOrganisationName] = useState('');
  const [ingestIntervalSeconds, setIngestIntervalSeconds] = useState('60');
  const [acceptableUsePolicy, setAcceptableUsePolicy] = useState('');
  const [licensedSeats, setLicensedSeats] = useState('');
  const [dbStats, setDbStats] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { showToast } = useToast();

  // FinOps feature-flag state
  const [financeModelEfficiencyEnabled, setFinanceModelEfficiencyEnabled] = useState(false);
  const [financeSaving, setFinanceSaving] = useState(false);
  const [chargebackEnabled, setChargebackEnabled] = useState(false);
  const [chargebackSaving, setChargebackSaving] = useState(false);
  const [finopsSeatPriceMonthly, setFinopsSeatPriceMonthly] = useState('');
  const [seatPriceSaving, setSeatPriceSaving] = useState(false);

  // Core AI model state
  const [coreAiModel, setCoreAiModel] = useState('claude-haiku-4-5-20251001');
  const [coreAiSaving, setCoreAiSaving] = useState(false);
  const [aiModels, setAiModels] = useState<{ id: string; display_name: string }[]>([]);
  const [aiModelsLoading, setAiModelsLoading] = useState(true);

  // Diagnostics state
  const [diagChecks, setDiagChecks] = useState<DiagCheck[]>(INITIAL_CHECKS);
  const [diagRunning, setDiagRunning] = useState(false);
  const [integrityRunning, setIntegrityRunning] = useState(false);
  const [integrityResult, setIntegrityResult] = useState<string | null>(null);

  // Weekly Digest state
  const [digestEnabled, setDigestEnabled] = useState(false);
  const [digestSendHourUtc, setDigestSendHourUtc] = useState('7');
  const [digestRecipients, setDigestRecipients] = useState('');
  const [digestSlackWebhookUrl, setDigestSlackWebhookUrl] = useState('');
  const [digestHubUrl, setDigestHubUrl] = useState('');
  const [digestLastSentWeek, setDigestLastSentWeek] = useState<string | null>(null);
  const [digestNextSendPreview, setDigestNextSendPreview] = useState('');
  const [digestChannels, setDigestChannels] = useState({ email: false, slack: false });
  const [digestSaving, setDigestSaving] = useState(false);
  const [digestTesting, setDigestTesting] = useState(false);
  const [digestTestResult, setDigestTestResult] = useState<DigestTestResult | null>(null);

  // Metrics Connector state
  const [connectorTokens, setConnectorTokens] = useState<ConnectorToken[]>([]);
  const [connectorEndpoints, setConnectorEndpoints] = useState<ConnectorEndpoints | null>(null);
  const [connectorLoading, setConnectorLoading] = useState(true);
  const [connectorName, setConnectorName] = useState('');
  const [connectorMinting, setConnectorMinting] = useState(false);
  const [mintedToken, setMintedToken] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);

  const loadDigestConfig = () => {
    fetch('/api/admin/digest')
      .then(r => r.json())
      .then((data: DigestConfig) => {
        setDigestEnabled(!!data.digestEnabled);
        setDigestSendHourUtc(String(data.digestSendHourUtc ?? 7));
        setDigestRecipients(data.digestRecipients || '');
        setDigestSlackWebhookUrl(data.digestSlackWebhookUrl || '');
        setDigestHubUrl(data.digestHubUrl || '');
        setDigestLastSentWeek(data.digestLastSentWeek);
        setDigestNextSendPreview(data.nextSendPreview || '');
        setDigestChannels(data.channels || { email: false, slack: false });
      })
      .catch(console.error);
  };

  const loadConnectorTokens = () => {
    setConnectorLoading(true);
    fetch('/api/admin/connector-tokens')
      .then(r => r.json())
      .then((data: { tokens: ConnectorToken[]; endpoints: ConnectorEndpoints }) => {
        setConnectorTokens(data.tokens || []);
        setConnectorEndpoints(data.endpoints || null);
      })
      .catch(console.error)
      .finally(() => setConnectorLoading(false));
  };

  useEffect(() => {
    Promise.all([
      fetch('/api/config').then(r => r.json()),
      fetch('/api/db/stats').then(r => r.json()),
    ])
      .then(([configData, statsData]) => {
        if (configData.organisationName) setOrganisationName(String(configData.organisationName));
        if (configData.ingestIntervalSeconds) setIngestIntervalSeconds(String(configData.ingestIntervalSeconds));
        if (configData.acceptableUsePolicy) setAcceptableUsePolicy(String(configData.acceptableUsePolicy));
        if (configData.licensedSeats) setLicensedSeats(String(configData.licensedSeats));
        setFinanceModelEfficiencyEnabled(
          configData.financeModelEfficiencyEnabled === true || configData.financeModelEfficiencyEnabled === 'true'
        );
        setChargebackEnabled(
          configData.chargebackEnabled === true || configData.chargebackEnabled === 'true'
        );
        if (configData.finopsSeatPriceMonthly) setFinopsSeatPriceMonthly(String(configData.finopsSeatPriceMonthly));
        if (configData.coreAiModel) setCoreAiModel(String(configData.coreAiModel));
        setDbStats(statsData);
      })
      .catch(console.error)
      .finally(() => setLoading(false));

    loadDigestConfig();
    loadConnectorTokens();
  }, []);

  useEffect(() => {
    fetch('/api/anthropic/models')
      .then((r) => r.json())
      .then((d) => setAiModels(d.models ?? []))
      .catch(() => setAiModels([]))
      .finally(() => setAiModelsLoading(false));
  }, []);

  const handleMintConnectorToken = async () => {
    const name = connectorName.trim();
    if (!name) {
      showToast('Enter a name for the token', 'error');
      return;
    }
    setConnectorMinting(true);
    try {
      const res = await fetch('/api/admin/connector-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (res.ok) {
        setMintedToken(data.token);
        setConnectorName('');
        loadConnectorTokens();
        showToast('Token minted', 'success');
      } else {
        showToast(data.error || 'Failed to mint token', 'error');
      }
    } catch {
      showToast('Failed to mint token', 'error');
    } finally {
      setConnectorMinting(false);
    }
  };

  const handleRevokeConnectorToken = async (id: string) => {
    setRevokingId(id);
    try {
      const res = await fetch(`/api/admin/connector-tokens?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok && data.revoked) {
        showToast('Token revoked', 'success');
        loadConnectorTokens();
      } else {
        showToast(data.error || 'Token could not be revoked', 'error');
      }
    } catch {
      showToast('Failed to revoke token', 'error');
    } finally {
      setRevokingId(null);
      setConfirmRevokeId(null);
    }
  };

  const handleCopyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(`${label} copied`, 'success');
    } catch {
      showToast('Copy failed. Select and copy manually', 'error');
    }
  };

  const handleSaveDigest = async () => {
    setDigestSaving(true);
    try {
      const res = await fetch('/api/admin/digest', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          digestEnabled: String(digestEnabled),
          digestSendHourUtc,
          digestRecipients,
          digestSlackWebhookUrl,
          digestHubUrl,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        showToast('Weekly Digest settings saved', 'success');
        loadDigestConfig();
      } else {
        showToast(data.error || 'Failed to save digest settings', 'error');
      }
    } catch {
      showToast('Failed to save digest settings', 'error');
    } finally {
      setDigestSaving(false);
    }
  };

  const handleSendDigestTest = async () => {
    setDigestTesting(true);
    setDigestTestResult(null);
    try {
      const res = await fetch('/api/admin/digest/test', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setDigestTestResult(data);
        showToast('Test digest dispatched', 'success');
      } else {
        showToast(data.error || 'Failed to send test digest', 'error');
      }
    } catch {
      showToast('Failed to send test digest', 'error');
    } finally {
      setDigestTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organisationName, ingestIntervalSeconds, acceptableUsePolicy, licensedSeats }),
      });
      if (res.ok) {
        showToast('Settings saved successfully', 'success');
      } else {
        const data = await res.json();
        showToast(data.error || 'Failed to save settings', 'error');
      }
    } catch {
      showToast('Failed to save settings', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveChargeback = async (nextEnabled: boolean) => {
    setChargebackSaving(true);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chargebackEnabled: nextEnabled ? 'true' : 'false' }),
      });
      if (res.ok) {
        setChargebackEnabled(nextEnabled);
        showToast('Settings saved successfully', 'success');
      } else {
        const data = await res.json();
        showToast(data.error || 'Failed to save settings', 'error');
      }
    } catch {
      showToast('Failed to save settings', 'error');
    } finally {
      setChargebackSaving(false);
    }
  };

  const handleSaveFinanceModelEfficiency = async (nextEnabled: boolean) => {
    setFinanceSaving(true);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ financeModelEfficiencyEnabled: nextEnabled ? 'true' : 'false' }),
      });
      if (res.ok) {
        setFinanceModelEfficiencyEnabled(nextEnabled);
        showToast('Settings saved successfully', 'success');
      } else {
        const data = await res.json();
        showToast(data.error || 'Failed to save settings', 'error');
      }
    } catch {
      showToast('Failed to save settings', 'error');
    } finally {
      setFinanceSaving(false);
    }
  };

  const handleSaveSeatPrice = async () => {
    setSeatPriceSaving(true);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ finopsSeatPriceMonthly }),
      });
      if (res.ok) {
        showToast('Settings saved successfully', 'success');
      } else {
        const data = await res.json();
        showToast(data.error || 'Failed to save settings', 'error');
      }
    } catch {
      showToast('Failed to save settings', 'error');
    } finally {
      setSeatPriceSaving(false);
    }
  };

  const handleSaveCoreAiModel = async () => {
    setCoreAiSaving(true);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coreAiModel }),
      });
      if (res.ok) {
        showToast('Settings saved successfully', 'success');
      } else {
        const data = await res.json();
        showToast(data.error || 'Failed to save settings', 'error');
      }
    } catch {
      showToast('Failed to save settings', 'error');
    } finally {
      setCoreAiSaving(false);
    }
  };

  const handleDownloadBundle = async () => {
    try {
      const res = await fetch('/api/support/bundle');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ccc-support-bundle.zip';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      showToast('Failed to download support bundle', 'error');
    }
  };

  const handleRunDiagnostics = async () => {
    setDiagRunning(true);
    // Reset all to running
    setDiagChecks(INITIAL_CHECKS.map(c => ({ ...c, status: 'running' })));

    const results: DiagCheck[] = [];
    for (const check of INITIAL_CHECKS) {
      if (check.run) {
        const { status, ms, detail } = await check.run();
        results.push({ ...check, status, ms, detail });
      } else {
        const start = performance.now();
        try {
          const res = await fetch(check.endpoint);
          const elapsed = Math.round(performance.now() - start);
          if (res.ok) {
            results.push({ ...check, status: 'pass', ms: elapsed, detail: `${res.status} OK` });
          } else {
            results.push({ ...check, status: 'fail', ms: elapsed, detail: `HTTP ${res.status}` });
          }
        } catch (err) {
          const elapsed = Math.round(performance.now() - start);
          results.push({
            ...check,
            status: 'fail',
            ms: elapsed,
            detail: err instanceof Error ? err.message : 'Network error',
          });
        }
      }
      // Update state incrementally so user sees results as they arrive
      setDiagChecks(prev => {
        const updated = [...prev];
        const idx = updated.findIndex(c => c.endpoint === check.endpoint);
        if (idx !== -1) updated[idx] = results[results.length - 1];
        return updated;
      });
    }

    setDiagRunning(false);
  };

  const handleIntegrityCheck = async () => {
    setIntegrityRunning(true);
    setIntegrityResult(null);
    try {
      const start = performance.now();
      const res = await fetch('/api/db/stats');
      const elapsed = Math.round(performance.now() - start);
      if (res.ok) {
        const data = await res.json();
        const sizeMb = (Number(data.fileSizeBytes) / 1024 / 1024).toFixed(2);
        setIntegrityResult(
          `OK (${elapsed}ms). DB size: ${sizeMb} MB, users: ${data.userCount}, chat: ${Number(data.chatCount).toLocaleString()}, code: ${Number(data.codeCount).toLocaleString()}, cowork: ${Number(data.coworkOnlyCount).toLocaleString()}, events: ${Number(data.otelCount).toLocaleString()}`
        );
      } else {
        setIntegrityResult("Couldn't run the check. Try again.");
      }
    } catch (err) {
      setIntegrityResult(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setIntegrityRunning(false);
    }
  };

  const statusBadge = (status: CheckStatus) => {
    if (status === 'idle') return <span className="text-[#B3B3B3] text-[13px]">—</span>;
    if (status === 'running') return <span className="text-[#245BF3] text-[13px] animate-pulse">Running…</span>;
    if (status === 'pass') return <Pill tone="good">Pass</Pill>;
    if (status === 'info') return <Pill tone="neutral">Info</Pill>;
    return <Pill tone="bad">Fail</Pill>;
  };

  if (loading) return (
    <>
      <TopBar title="System" subtitle="General configuration, diagnostics, and support" />
      <LoadingSpinner />
    </>
  );

  return (
    <>
      <TopBar title="System" subtitle="General configuration, diagnostics, and support" />
      <PageBody>

        <p className="m-0 text-[13px] text-[#4D4D4D]">
          Frontier Command Centre {packageJson.version} · Open source ·{' '}
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className={B.link}>GitHub</a> ·{' '}
          <a href={`${REPO_URL}/issues`} target="_blank" rel="noopener noreferrer" className={B.link}>Report an issue</a>
        </p>

        <SystemHealthCard />

        {/* General */}
        <Panel title="General" flush>
          <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Organisation name">
              <input
                type="text"
                value={organisationName}
                onChange={e => setOrganisationName(e.target.value)}
                className={cx(B.input, 'w-full')}
                placeholder="Your organisation name (used in reports)"
              />
            </Field>
            <Field label="Ingest interval (seconds)">
              <input
                type="number"
                value={ingestIntervalSeconds}
                onChange={e => setIngestIntervalSeconds(e.target.value)}
                className={cx(B.input, 'w-full')}
                min={10}
                max={3600}
              />
            </Field>
            <Field label="Licensed seats (optional)" hint="Shown as the Active Users denominator on the dashboard. Blank to hide.">
              <input
                type="number"
                value={licensedSeats}
                onChange={e => setLicensedSeats(e.target.value)}
                className={cx(B.input, 'w-full')}
                min={1}
                placeholder="e.g. 150"
              />
            </Field>
            <Field label="Acceptable use policy" className="md:col-span-3">
              <textarea
                value={acceptableUsePolicy}
                onChange={e => setAcceptableUsePolicy(e.target.value)}
                className={cx(B.input, 'w-full h-32 leading-5')}
                placeholder="Paste your organisation's acceptable use policy here. This text is used by the AI policy triage system to assess events against your rules."
              />
            </Field>
          </div>
          <div className="px-4 py-3 border-t border-[#F2F2F2] flex items-center gap-3">
            <button type="button" onClick={handleSave} disabled={saving} className={B.primary}>
              {saving ? 'Saving...' : 'Save settings'}
            </button>
          </div>
        </Panel>

        {/* Core AI model */}
        <Panel title="Core AI model" flush>
          <div className="p-4">
            <Field
              label="Model"
              hint="Model used by the dashboard Intelligence Briefing, anomaly detection, governance Reports, and intent AI-assessment. Defaults to Claude Haiku."
            >
              <ModelSelect
                value={coreAiModel}
                onChange={setCoreAiModel}
                models={aiModels}
                loading={aiModelsLoading}
              />
            </Field>
          </div>
          <div className="px-4 py-3 border-t border-[#F2F2F2] flex items-center gap-3">
            <button type="button" onClick={handleSaveCoreAiModel} disabled={coreAiSaving} className={B.primary}>
              {coreAiSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Panel>

        {/* FinOps */}
        <Panel title="FinOps" flush>
          <ToggleRow
            first
            label="Enable FinOps (cost and chargeback)"
            hint="Turns on the FinOps surface: per-user AI spend rolled up by cost centre for a calendar month. Visible to admin and manager roles only."
            checked={chargebackEnabled}
            onChange={handleSaveChargeback}
            disabled={chargebackSaving}
          />
          <ToggleRow
            label="Model efficiency (FinOps)"
            hint="Show the Model efficiency section on FinOps: spend by activity × model with review flags. Estimates, not billing. Requires FinOps (chargeback) enabled."
            checked={financeModelEfficiencyEnabled}
            onChange={handleSaveFinanceModelEfficiency}
            disabled={financeSaving}
          />
          <div className="px-4 py-3 border-t border-[#F2F2F2]">
            <Field label="Seat price (USD/month)" hint="Used only for the unused-seats estimate on FinOps." className="max-w-xs">
              <input
                type="number"
                min={0}
                value={finopsSeatPriceMonthly}
                onChange={(e) => setFinopsSeatPriceMonthly(e.target.value)}
                className={cx(B.input, 'w-full sm:w-48')}
                placeholder="e.g. 20"
              />
            </Field>
          </div>
          <div className="px-4 py-3 border-t border-[#F2F2F2] flex items-center gap-3">
            <button type="button" onClick={handleSaveSeatPrice} disabled={seatPriceSaving} className={B.primary}>
              {seatPriceSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Panel>

        {/* Weekly Digest */}
        <Panel
          title="Weekly digest"
          flush
          right={
            <>
              <Pill tone={digestChannels.email ? 'good' : 'neutral'}>Email: {digestChannels.email ? 'configured' : 'not configured'}</Pill>
              <Pill tone={digestChannels.slack ? 'good' : 'neutral'}>Slack: {digestChannels.slack ? 'configured' : 'not configured'}</Pill>
            </>
          }
        >
          <ToggleRow
            first
            label="Enable weekly digest"
            hint={<>Sends a Monday-morning summary of last week&apos;s AI activity (Developer Pulse + Work Pulse + top anomaly) over email and/or Slack. Saved with the settings below.</>}
            ariaLabel="Enable weekly digest"
            checked={digestEnabled}
            onChange={setDigestEnabled}
          />

          <div className="p-4 border-t border-[#F2F2F2] grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Send hour (UTC)" hint="Digest is only ever sent on Mondays, at or after this hour.">
              <select
                value={digestSendHourUtc}
                onChange={(e) => setDigestSendHourUtc(e.target.value)}
                className={cx(B.select, 'w-32')}
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                ))}
              </select>
            </Field>

            <Field label="Hub URL" hint={<>Used to build the &quot;Open Command Centre&quot; link in the digest.</>}>
              <input
                type="text"
                value={digestHubUrl}
                onChange={(e) => setDigestHubUrl(e.target.value)}
                className={cx(B.input, 'w-full')}
                placeholder="http://localhost:3001"
              />
            </Field>

            <Field label="Recipients (email)" hint="Comma-separated. Requires SMTP to be configured (Security tab)." className="md:col-span-2">
              <textarea
                value={digestRecipients}
                onChange={(e) => setDigestRecipients(e.target.value)}
                className={cx(B.input, 'w-full h-20 leading-5')}
                placeholder="exec@yourcompany.com, cio@yourcompany.com"
              />
            </Field>

            <div className="flex flex-col gap-1.5 md:col-span-2 min-w-0">
              <label htmlFor="digest-slack-webhook" className="text-[14px] font-medium text-[#0A0A0A]">Slack webhook URL</label>
              <div className="flex gap-2">
                <input
                  id="digest-slack-webhook"
                  type="password"
                  value={digestSlackWebhookUrl}
                  onChange={(e) => setDigestSlackWebhookUrl(e.target.value)}
                  className={cx(B.input, 'flex-1 min-w-0 font-mono')}
                  placeholder="https://hooks.slack.com/services/..."
                />
                <SecretRemoveButton
                  configKey="digestSlackWebhookUrl"
                  label="Digest Slack webhook"
                  hasValue={digestSlackWebhookUrl.length > 0}
                  onRemoved={() => setDigestSlackWebhookUrl('')}
                />
              </div>
            </div>
          </div>

          <div className="px-4 py-3 border-t border-[#F2F2F2] flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-[#666666]">
            <span>Last sent: <span className="text-[#0A0A0A]">{digestLastSentWeek ? new Date(Number(digestLastSentWeek) * 1000).toLocaleDateString() : 'Never'}</span></span>
            <span>Status: <span className="text-[#0A0A0A]">{digestNextSendPreview || '—'}</span></span>
          </div>

          {digestTestResult && (
            <div className="px-4 pb-3">
              <Notice tone={digestTestResult.email === 'failed' || digestTestResult.slack === 'failed' ? 'error' : 'success'}>
                {digestTestResult.isSample && <p className="m-0 mb-1 font-semibold">Sample data: no completed week yet</p>}
                <p className="m-0 font-mono text-[13px]">Email: {digestTestResult.email} &nbsp;|&nbsp; Slack: {digestTestResult.slack}</p>
                {digestTestResult.errors.length > 0 && (
                  <p className="m-0 mt-1 font-mono text-[13px]">{digestTestResult.errors.join('; ')}</p>
                )}
              </Notice>
            </div>
          )}

          <div className="px-4 py-3 border-t border-[#F2F2F2] flex flex-wrap items-center gap-2">
            <button type="button" onClick={handleSaveDigest} disabled={digestSaving} className={B.primary}>
              {digestSaving ? 'Saving...' : 'Save settings'}
            </button>
            <a
              href="/api/admin/digest/preview"
              target="_blank"
              rel="noopener noreferrer"
              className={B.accent}
            >
              Preview digest
            </a>
            <button type="button" onClick={handleSendDigestTest} disabled={digestTesting} className={B.secondary}>
              {digestTesting ? 'Sending...' : 'Send test now'}
            </button>
          </div>
        </Panel>

        <HighlightsCard />

        {/* Metrics Connector */}
        <Panel
          title="Metrics connector"
          subtitle="Read-only, org-level metrics for BI tools and Claude/MCP connectors, never per-person data."
          flush
        >
          {connectorLoading ? (
            <div className="p-4"><Muted>Loading...</Muted></div>
          ) : (
            <>
              {/* Endpoints */}
              {connectorEndpoints && (
                <div className="p-4">
                  <SubHead>Endpoints</SubHead>
                  <div className="flex flex-col gap-1.5">
                    {([
                      ['MCP', connectorEndpoints.mcp],
                      ['Export: summary', connectorEndpoints.exportSummary],
                      ['Export: trends', connectorEndpoints.exportTrends],
                      ['Export: health', connectorEndpoints.exportHealth],
                    ] as const).map(([label, url]) => (
                      <div key={label} className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2 text-[14px]">
                        <span className="text-[#666666] sm:w-36 shrink-0">{label}</span>
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <code className="flex-1 min-w-0 px-2 py-1 bg-[#FAFAFA] border border-[#EAEAEA] rounded-[6px] text-[13px] font-mono text-[#333333] overflow-x-auto whitespace-nowrap">
                            {url}
                          </code>
                          <button
                            type="button"
                            onClick={() => handleCopyToClipboard(url, label)}
                            aria-label={`Copy ${label} URL`}
                            className={cx(B.secondary, 'shrink-0')}
                          >
                            Copy
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Newly minted token: shown once */}
              {mintedToken && (
                <div className={cx('px-4 pb-4', !connectorEndpoints && 'pt-4')}>
                  <Notice tone="warn" title="Copy this token now, it will not be shown again.">
                    <div className="flex flex-wrap items-center gap-2 mt-2">
                      <code className="flex-1 min-w-0 px-2 py-1.5 bg-white border border-[#F5D9A8] rounded-[6px] text-[13px] font-mono text-[#0A0A0A] overflow-x-auto whitespace-nowrap">
                        {mintedToken}
                      </code>
                      <button
                        type="button"
                        onClick={() => handleCopyToClipboard(mintedToken, 'Token')}
                        className={cx(B.primary, 'shrink-0')}
                      >
                        Copy
                      </button>
                      <button
                        type="button"
                        onClick={() => setMintedToken(null)}
                        className={cx(B.secondary, 'shrink-0')}
                      >
                        Dismiss
                      </button>
                    </div>
                  </Notice>
                </div>
              )}

              {/* Mint form */}
              <div className={cx('px-4 py-3 flex flex-wrap items-end gap-2', (connectorEndpoints || mintedToken) && 'border-t border-[#F2F2F2]')}>
                <div className="flex flex-col gap-1.5 flex-1 min-w-[200px]">
                  <label htmlFor="connector-token-name" className="text-[14px] font-medium text-[#0A0A0A]">New token name</label>
                  <input
                    id="connector-token-name"
                    type="text"
                    value={connectorName}
                    onChange={(e) => setConnectorName(e.target.value)}
                    className={cx(B.input, 'w-full')}
                    placeholder="e.g. Looker BI connector"
                    maxLength={100}
                  />
                </div>
                <button
                  type="button"
                  onClick={handleMintConnectorToken}
                  disabled={connectorMinting || !connectorName.trim()}
                  className={B.primary}
                >
                  {connectorMinting ? 'Minting...' : 'Mint token'}
                </button>
              </div>

              {/* Token table */}
              {connectorTokens.length === 0 ? (
                <div className="px-4 py-3 border-t border-[#F2F2F2]">
                  <Muted>No connector tokens yet. Mint one above to connect a BI tool or MCP client.</Muted>
                </div>
              ) : (
                <div className="overflow-x-auto border-t border-[#EAEAEA]">
                  <table className={T.table}>
                    <thead>
                      <tr className={T.headRow}>
                        <th scope="col" className={T.th}>Name</th>
                        <th scope="col" className={T.th}>Created</th>
                        <th scope="col" className={T.th}>Last used</th>
                        <th scope="col" className={T.th}>Status</th>
                        <th scope="col" className={T.thRight}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {connectorTokens.map((t) => (
                        <tr key={t.id} className={T.row}>
                          <td className={cx(T.td, 'font-medium text-[#0A0A0A]')}>{t.name}</td>
                          <td className={cx(T.tdMute, 'tabular-nums whitespace-nowrap')}>{new Date(t.createdAt * 1000).toLocaleDateString()}</td>
                          <td className={cx(T.tdMute, 'tabular-nums whitespace-nowrap')}>
                            {t.lastUsedAt ? new Date(t.lastUsedAt * 1000).toLocaleString() : 'Never'}
                          </td>
                          <td className={T.td}>
                            {t.revokedAt ? <Pill tone="bad">Revoked</Pill> : <Pill tone="good">Active</Pill>}
                          </td>
                          <td className={cx(T.td, 'text-right whitespace-nowrap')}>
                            {!t.revokedAt && (
                              confirmRevokeId === t.id ? (
                                <span className="inline-flex items-center gap-2">
                                  <span className="text-[13px] text-[#666666]">Revoke?</span>
                                  <button
                                    type="button"
                                    onClick={() => handleRevokeConnectorToken(t.id)}
                                    disabled={revokingId === t.id}
                                    className={B.danger}
                                  >
                                    {revokingId === t.id ? 'Revoking...' : 'Confirm'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setConfirmRevokeId(null)}
                                    className={B.secondary}
                                  >
                                    Cancel
                                  </button>
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setConfirmRevokeId(t.id)}
                                  className={B.danger}
                                >
                                  Revoke
                                </button>
                              )
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </Panel>

        {/* Support */}
        <Panel title="Support">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <p className="m-0 flex-1 text-[14px] text-[#4D4D4D] leading-5">
              Downloads a ZIP containing crash logs, error history, and system info for support purposes. Credentials are automatically redacted.
            </p>
            <button type="button" onClick={handleDownloadBundle} className={cx(B.secondary, 'shrink-0 self-start sm:self-auto')}>
              Download support bundle
            </button>
          </div>
        </Panel>

        {/* Database Health */}
        <Panel title="Database health" subtitle="Read-only database health metrics." flush>
          {dbStats ? (
            <>
              <div className="overflow-hidden">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 -mr-px -mb-px [&>*]:border-[#EAEAEA] [&>*]:border-r [&>*]:border-b">
                  <Figure label="Database size" value={(Number(dbStats.fileSizeBytes) / 1024 / 1024).toFixed(2)} unit="MB" />
                  <Figure label="Users" value={String(dbStats.userCount)} />
                  <Figure label="Chat prompts" value={Number(dbStats.chatCount).toLocaleString()} />
                  <Figure label="Code messages" value={Number(dbStats.codeCount).toLocaleString()} />
                  <Figure label="Cowork messages" value={Number(dbStats.coworkOnlyCount).toLocaleString()} />
                  <Figure label="OTel events" value={Number(dbStats.otelCount).toLocaleString()} />
                  <Figure label="Compliance events" value={Number(dbStats.complianceCount).toLocaleString()} />
                </div>
              </div>
              <div className="px-4 py-3 border-t border-[#EAEAEA] flex flex-col gap-1 text-[13px] text-[#666666]">
                <span>
                  Last retention cleanup:{' '}
                  <span className="text-[#0A0A0A]">
                    {dbStats.retentionLastRun
                      ? new Date(String(dbStats.retentionLastRun)).toLocaleString()
                      : 'Never'}
                  </span>
                </span>
                {!!dbStats.retentionLastResult && (
                  <span>
                    Last cleanup result:{' '}
                    <span className="font-mono text-[#0A0A0A] break-words">
                      {(() => {
                        const r = dbStats.retentionLastResult as Record<string, unknown>;
                        return `${r.mode}: cowork=${r.cowork_rows_affected}, otel=${r.otel_rows_affected}, compliance=${r.compliance_rows_affected}, chat=${r.chat_rows_affected ?? 0}, error=${r.error_rows_affected ?? 0}`;
                      })()}
                    </span>
                  </span>
                )}
              </div>
            </>
          ) : (
            <div className="p-4"><Muted>Loading...</Muted></div>
          )}
        </Panel>

        {/* Diagnostics */}
        <Panel
          title="Diagnostics"
          flush
          right={
            <button type="button" onClick={handleRunDiagnostics} disabled={diagRunning} className={B.primary}>
              {diagRunning ? 'Running checks…' : 'Run diagnostics'}
            </button>
          }
        >
          {/* Connectivity checks */}
          <div className="px-4 pt-4 pb-2">
            <SubHead>Connectivity checks</SubHead>
            <Muted>Runs a sequence of requests to verify that all core API endpoints are reachable and responding correctly.</Muted>
          </div>
          <div className="overflow-x-auto">
            <table className={T.table}>
              <thead>
                <tr className={T.headRow}>
                  <th scope="col" className={T.th}>Check</th>
                  <th scope="col" className={T.th}>Status</th>
                  <th scope="col" className={T.thRight}>Time</th>
                  <th scope="col" className={T.th}>Detail</th>
                </tr>
              </thead>
              <tbody>
                {diagChecks.map(check => (
                  <tr key={check.endpoint} className={T.row}>
                    <td className={cx(T.td, 'font-medium text-[#0A0A0A]')}>{check.name}</td>
                    <td className={T.td}>{statusBadge(check.status)}</td>
                    <td className={cx(T.tdRight, 'text-[#666666]')}>
                      {check.ms !== null ? `${check.ms}ms` : '—'}
                    </td>
                    <td className={cx(T.td, 'text-[13px] text-[#8F8F8F]')}>{check.detail || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Database integrity check (PostgreSQL) */}
          <div className="p-4 border-t border-[#EAEAEA] flex flex-col gap-3">
            <div>
              <SubHead>Database integrity check</SubHead>
              <Muted>Verifies database accessibility by fetching current stats. Confirms the database is reachable and returns its size and row counts.</Muted>
            </div>

            {integrityResult && (
              <Notice tone={integrityResult.startsWith('OK') ? 'success' : 'error'}>
                <span className="font-mono text-[13px] break-words">{integrityResult}</span>
              </Notice>
            )}

            <div>
              <button type="button" onClick={handleIntegrityCheck} disabled={integrityRunning} className={B.secondary}>
                {integrityRunning ? 'Checking…' : 'Run integrity check'}
              </button>
            </div>
          </div>
        </Panel>

      </PageBody>
    </>
  );
}
