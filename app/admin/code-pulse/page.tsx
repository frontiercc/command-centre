// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { useToast } from '@/components/shared/ToastProvider';
import CodeClassifierTab from '@/components/pulse/admin/CodeClassifierTab';
import CodeClassifierHealthTab from '@/components/pulse/admin/CodeClassifierHealthTab';
import SecretRemoveButton from '@/components/admin/SecretRemoveButton';
import GithubIdentityPanel from '@/components/pulse/admin/GithubIdentityPanel';
import { effectiveCodeHumanTime } from '@/lib/pulse/human-time';
import { PageBody, Panel, Tabs, Figure, Tag, Pill, Notice, Muted, SubHead, B, T, cx } from '@/components/precision/ui';
import { ToggleRow, Field } from '@/components/admin/precision-admin';

type Tab = 'overview' | 'github' | 'value' | 'framework' | 'rates' | 'data-quality' | 'classifier-health' | 'tiers';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'github', label: 'GitHub overlay' },
  { id: 'value', label: 'Value' },
  { id: 'framework', label: 'Framework' },
  { id: 'rates', label: 'Rates' },
  { id: 'data-quality', label: 'Data quality' },
  { id: 'tiers', label: 'Tiers' },
  { id: 'classifier-health', label: 'Classifier health' },
];

/** Figures inside a panel, joined by hairline dividers (a Strip without its own border). */
function PanelFigures({ children, cols }: { children: ReactNode; cols: 2 | 3 }) {
  return (
    <div className={cx('grid grid-cols-1', cols === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-3',
      '[&>*]:border-[#F2F2F2] [&>*+*]:border-t sm:[&>*+*]:border-t-0 sm:[&>*+*]:border-l')}>
      {children}
    </div>
  );
}

/** Footer row of a settings panel: the save button and anything beside it. */
function PanelActions({ children }: { children: ReactNode }) {
  return <div className="px-4 py-3 border-t border-[#F2F2F2] flex items-center gap-3 flex-wrap">{children}</div>;
}

const inlineCode = 'font-mono text-[12px] bg-[#F2F2F2] px-1 rounded-[6px]';

interface GithubData {
  reposSeen: string[];
  mappings: Array<{ repo: string; github_repo: string }>;
  tokenConfigured: boolean;
  lastSync: string | null;
}

interface ClassifierData {
  enabled: boolean;
  model: string;
  includePrompt: boolean;
  briefings: number;
}

interface ModelRate {
  in: number;
  out: number;
  cacheWrite: number;
  cacheRead: number;
}

interface RatesData {
  rates: Record<string, ModelRate>;
  defaults: Record<string, ModelRate>;
  unpricedModels: string[];
}

interface CodeHealth {
  unpricedModels: Array<{ model: string; sessions: number; totalTokens: number }>;
  estimatedModels: Array<{ model: string; sessions: number }>;
  unattributedOtel: { rows: number; distinctEmails: number };
  orphanSessions: number;
  malformedModelsJson: number;
  aggregatorLastRun: string | null;
  lastOtelIngest: number | null;
  lastMetaIngest: number | null;
}

// ── Shared with the Work Pulse admin look ──────────────────────────────────

const FAMILIES = ['haiku', 'sonnet', 'opus'] as const;

function ModelSelect({
  value, onChange, models, loading, followLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  models: { id: string; display_name: string }[];
  loading: boolean;
  /** When set, a first option (value '') that follows another setting. */
  followLabel?: string;
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className={cx(B.select, 'w-full')}
    >
      {followLabel !== undefined && <option value="">{followLabel}</option>}
      {loading && (
        <>
          {value !== '' && <option value={value}>{value}</option>}
          <option disabled value="__loading">Loading models…</option>
        </>
      )}
      {!loading && models.length === 0 && value !== '' && <option value={value}>{value}</option>}
      {!loading && models.length > 0 && (
        <>
          {FAMILIES.map(family => {
            const group = models.filter(m => m.id.toLowerCase().includes(family));
            if (!group.length) return null;
            return (
              <optgroup key={family} label={family.charAt(0).toUpperCase() + family.slice(1)}>
                {group.map(m => <option key={m.id} value={m.id}>{m.display_name || m.id}</option>)}
              </optgroup>
            );
          })}
          {(() => {
            const other = models.filter(m => !FAMILIES.some(f => m.id.toLowerCase().includes(f)));
            if (!other.length) return null;
            return (
              <optgroup key="other" label="Other">
                {other.map(m => <option key={m.id} value={m.id}>{m.display_name || m.id}</option>)}
              </optgroup>
            );
          })()}
        </>
      )}
    </select>
  );
}

// ── Value Calibrations Panel ─────────────────────────────────────────────────

const VALUE_DEFAULTS: Record<string, string> = {
  codeValueLiftPct: '30', codeValueLoadedComp: '300000', codeValueCodingHrs: '15',
  timeSavedMinPerPr: '150', timeSavedMinPerCommit: '20', timeSavedMinPerCoworkSession: '10', timeSavedMinPerChatConversation: '4',
};
const normDefault = (key: string, val: unknown) => {
  const s = val == null ? '' : String(val);
  return s === '' || s === VALUE_DEFAULTS[key] ? '' : s;
};

function ValueCalibrationsPanel() {
  const [form, setForm] = useState({
    codeValueEnabled: 'true',
    codeValueLiftPct: '',
    codeValueLoadedComp: '',
    codeValueCodingHrs: '',
    codeValueTeamSize: '',
    codeValueAnnualSpend: '',
    timeSavedMinPerPr: '',
    timeSavedMinPerCommit: '',
    timeSavedMinPerCoworkSession: '',
    timeSavedMinPerChatConversation: '',
  });
  const [saving, setSaving] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(c => setForm(f => ({
        ...f,
        codeValueEnabled: String(c.codeValueEnabled ?? 'true'),
        codeValueLiftPct: normDefault('codeValueLiftPct', c.codeValueLiftPct),
        codeValueLoadedComp: normDefault('codeValueLoadedComp', c.codeValueLoadedComp),
        codeValueCodingHrs: normDefault('codeValueCodingHrs', c.codeValueCodingHrs),
        codeValueTeamSize: c.codeValueTeamSize ?? '',
        codeValueAnnualSpend: c.codeValueAnnualSpend ?? '',
        timeSavedMinPerPr: normDefault('timeSavedMinPerPr', c.timeSavedMinPerPr),
        timeSavedMinPerCommit: normDefault('timeSavedMinPerCommit', c.timeSavedMinPerCommit),
        timeSavedMinPerCoworkSession: normDefault('timeSavedMinPerCoworkSession', c.timeSavedMinPerCoworkSession),
        timeSavedMinPerChatConversation: normDefault('timeSavedMinPerChatConversation', c.timeSavedMinPerChatConversation),
      })))
      .catch(() => {});
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
      showToast('Value calibrations saved. Applies org-wide', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const fields: Array<{ key: keyof typeof form; label: string; placeholder: string; hint: string }> = [
    { key: 'codeValueLiftPct', label: 'Productivity lift (%)', placeholder: '30', hint: 'Anthropic enterprise benchmark. Override with your own measurement.' },
    { key: 'codeValueLoadedComp', label: 'Loaded annual comp (USD)', placeholder: '300000', hint: 'Per engineer, fully loaded.' },
    { key: 'codeValueCodingHrs', label: 'Coding hours / week', placeholder: '15', hint: 'Used only for the "time recovered" figure.' },
    { key: 'codeValueTeamSize', label: 'Team size (blank = from data)', placeholder: 'active Code users', hint: 'Leave blank to use active Code users in the period.' },
    { key: 'codeValueAnnualSpend', label: 'Annual spend (blank = from data)', placeholder: 'annualised from usage', hint: 'Leave blank to annualise from measured spend.' },
  ];

  const timeSavedFields: Array<{ key: keyof typeof form; label: string; placeholder: string }> = [
    { key: 'timeSavedMinPerPr', label: 'Minutes per PR', placeholder: '150' },
    { key: 'timeSavedMinPerCommit', label: 'Minutes per AI-assisted commit', placeholder: '20' },
    { key: 'timeSavedMinPerCoworkSession', label: 'Minutes per Cowork session', placeholder: '10' },
    { key: 'timeSavedMinPerChatConversation', label: 'Minutes per Chat conversation', placeholder: '4' },
  ];

  return (
    <Panel
      title="Value estimate calibrations"
      subtitle="The headline value is computed from measured usage plus these inputs. Saving applies org-wide."
      right={<Tag tone="judged">Estimate</Tag>}
      flush
    >
      <ToggleRow
        first
        label="Show the Value view"
        checked={form.codeValueEnabled !== 'false'}
        onChange={next => setForm(f => ({ ...f, codeValueEnabled: next ? 'true' : 'false' }))}
      />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 px-4 py-4 border-t border-[#F2F2F2]">
        {fields.map(fd => (
          <Field key={fd.key} label={fd.label} hint={fd.hint}>
            <input
              value={form[fd.key]}
              placeholder={fd.placeholder}
              onChange={ev => setForm(f => ({ ...f, [fd.key]: ev.target.value }))}
              className={cx(B.input, 'w-full')}
            />
          </Field>
        ))}
      </div>

      <div className="px-4 py-4 border-t border-[#F2F2F2]">
        <SubHead right={<Tag tone="judged">Estimate</Tag>}>Time saved (bottom-up estimate)</SubHead>
        <p className="m-0 mb-3 text-[13px] text-[#8F8F8F] leading-5">
          Minutes-per-task assumptions behind the Time saved card on the Value page. Blank uses the default shown as a placeholder.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {timeSavedFields.map(fd => (
            <Field key={fd.key} label={fd.label}>
              <input
                value={form[fd.key]}
                placeholder={fd.placeholder}
                onChange={ev => setForm(f => ({ ...f, [fd.key]: ev.target.value }))}
                className={cx(B.input, 'w-full')}
              />
            </Field>
          ))}
        </div>
      </div>

      <PanelActions>
        <button type="button" onClick={handleSave} disabled={saving} className={B.primary}>
          {saving ? 'Saving...' : 'Save'}
        </button>
      </PanelActions>
    </Panel>
  );
}

// ── Framework Admin Panel ─────────────────────────────────────────────────────

function FrameworkAdminPanel() {
  const [enabled, setEnabled] = useState(false);
  const [mock, setMock] = useState(false);
  const [instanceUrl, setInstanceUrl] = useState('');
  const [token, setToken] = useState('');
  const [tokenConfigured, setTokenConfigured] = useState(false);
  const [saving, setSaving] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(c => {
        setEnabled(c.dxFrameworkEnabled === true || c.dxFrameworkEnabled === 'true');
        setMock(c.dxFrameworkMock === 'true');
        setInstanceUrl(c.dxInstanceUrl || '');
        setTokenConfigured(!!c.dxApiKey);
      })
      .catch(() => {});
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const body: Record<string, string> = {
        dxFrameworkEnabled: enabled ? 'true' : 'false',
        dxFrameworkMock: mock ? 'true' : 'false',
        dxInstanceUrl: instanceUrl.trim(),
      };
      if (token.trim()) body.dxApiKey = token.trim();
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
      showToast('Dev Framework Alignment settings saved', 'success');
      if (token.trim()) setTokenConfigured(true);
      setToken('');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel
      title="Dev Framework Alignment"
      subtitle="Live DX read is not yet verified against a real workspace: the DEMO overlay is the current demo path."
      flush
    >
      <ToggleRow
        first
        label="Enable Dev Framework Alignment"
        hint="Turns the surface on org-wide."
        checked={enabled}
        onChange={setEnabled}
      />
      <ToggleRow
        label="Show DEMO overlay"
        hint="Illustrative getDX-shaped data for demoing the surface before a live workspace is connected."
        checked={mock}
        onChange={setMock}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 px-4 py-4 border-t border-[#F2F2F2]">
        <Field label="DX instance URL">
          <input
            value={instanceUrl}
            onChange={e => setInstanceUrl(e.target.value)}
            placeholder="https://yourcompany.getdx.net"
            className={cx(B.input, 'w-full')}
          />
        </Field>

        <div className="flex items-end gap-2 min-w-0">
          <Field label="DX API token" className="flex-1">
            <input
              type="password"
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder={tokenConfigured ? 'Token configured. Paste to replace' : 'Read-scoped org token'}
              className={cx(B.input, 'w-full')}
            />
          </Field>
          <SecretRemoveButton
            configKey="dxApiKey"
            label="DX API token"
            hasValue={tokenConfigured}
            onRemoved={() => { setTokenConfigured(false); setToken(''); }}
          />
        </div>
      </div>

      <PanelActions>
        <button type="button" onClick={handleSave} disabled={saving} className={B.primary}>
          {saving ? 'Saving...' : 'Save'}
        </button>
      </PanelActions>
    </Panel>
  );
}

// ── Rates Panel ───────────────────────────────────────────────────────────────

const EMPTY_RATE: ModelRate = { in: 0, out: 0, cacheWrite: 0, cacheRead: 0 };
const RATE_LABEL: Record<keyof ModelRate, string> = { in: 'In', out: 'Out', cacheWrite: 'Cache write', cacheRead: 'Cache read' };

function RatesPanel({ prefillModel }: { prefillModel: string | null }) {
  const [data, setData] = useState<RatesData | null>(null);
  const [rows, setRows] = useState<Array<{ model: string } & ModelRate>>([]);
  const [saving, setSaving] = useState(false);
  const { showToast } = useToast();

  const load = () => {
    fetch('/api/pulse/code/rates')
      .then(r => r.json())
      .then((d: RatesData) => {
        setData(d);
        setRows(Object.entries(d.rates).map(([model, r]) => ({ model, ...r })));
      })
      .catch(() => {});
  };

  useEffect(() => { load(); }, []);

  // Deep-link from the Data Quality tab's "Add rate" — prefill a blank row for the model.
  useEffect(() => {
    if (!prefillModel || !data) return;
    setRows(prev => (prev.some(r => r.model === prefillModel)
      ? prev
      : [...prev, { model: prefillModel, ...EMPTY_RATE }]));
  }, [prefillModel, data]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const rates: Record<string, ModelRate> = {};
      for (const row of rows) {
        if (!row.model.trim()) continue;
        rates[row.model.trim()] = { in: row.in, out: row.out, cacheWrite: row.cacheWrite, cacheRead: row.cacheRead };
      }
      const res = await fetch('/api/pulse/code/rates', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rates }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
      showToast('Model rates saved', 'success');
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!data) return <LoadingSpinner />;

  return (
    <Panel title="Model rates ($/MTok)" flush>
      <div className="px-4 py-3 flex flex-col gap-3">
        <p className="m-0 text-[13px] text-[#666666] leading-5">
          Overrides and additions to the built-in Anthropic list rates. A model with no entry here (and no
          normalisable Bedrock/Vertex match) prices as unpriced, never silently zero. Add the exact
          provider-decorated model ID (e.g. <code className={inlineCode}>us.anthropic.claude-opus-4-6-v1</code>)
          for real AWS/GCP cost instead of the Anthropic list-rate estimate.
        </p>

        {data.unpricedModels.length > 0 && (
          <Notice tone="warn">Seen with no rate entry: {data.unpricedModels.join(', ')}</Notice>
        )}
      </div>

      <div className="overflow-x-auto border-t border-[#F2F2F2]">
        <table className={T.table}>
          <thead>
            <tr className={T.headRow}>
              <th className={T.th}>Model ID</th>
              <th className={T.th}>In</th>
              <th className={T.th}>Out</th>
              <th className={T.th}>Cache write</th>
              <th className={T.th}>Cache read</th>
              <th className={T.th}><span className="sr-only">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className={T.row}>
                <td className={T.td}>
                  <input
                    value={row.model}
                    onChange={e => setRows(prev => prev.map((r, j) => (j === i ? { ...r, model: e.target.value } : r)))}
                    placeholder="model-id"
                    aria-label="Model ID"
                    className={cx(B.input, 'w-full min-w-[200px] font-mono text-[13px]')}
                  />
                </td>
                {(['in', 'out', 'cacheWrite', 'cacheRead'] as const).map(field => (
                  <td key={field} className={T.td}>
                    <input
                      type="number"
                      step="0.01"
                      value={row[field]}
                      onChange={e => setRows(prev => prev.map((r, j) => (j === i ? { ...r, [field]: parseFloat(e.target.value) || 0 } : r)))}
                      aria-label={`${RATE_LABEL[field]} rate`}
                      className={cx(B.input, 'w-24 tabular-nums')}
                    />
                  </td>
                ))}
                <td className={cx(T.td, 'text-right')}>
                  <button
                    type="button"
                    onClick={() => setRows(prev => prev.filter((_, j) => j !== i))}
                    className="text-[16px] leading-none px-2 text-[#8F8F8F] hover:text-[#B42318]"
                    aria-label="Remove rate"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <PanelActions>
        <button type="button" onClick={handleSave} disabled={saving} className={B.primary}>
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => setRows(prev => [...prev, { model: '', ...EMPTY_RATE }])}
          className={B.secondary}
        >
          + Add rate
        </button>
      </PanelActions>
    </Panel>
  );
}

// ── Health Panel ─────────────────────────────────────────────────────────────

function StalenessChip({ timestamp, warnAfterHours }: { timestamp: number | string | null; warnAfterHours: number }) {
  if (timestamp === null) {
    return <Pill>Never</Pill>;
  }
  const ms = typeof timestamp === 'number' ? timestamp * 1000 : new Date(timestamp).getTime();
  const ageHours = (Date.now() - ms) / (1000 * 60 * 60);
  const stale = ageHours > warnAfterHours;
  return (
    <Pill tone={stale ? 'warn' : 'good'}>
      <span className="tabular-nums">{new Date(ms).toLocaleString()}</span>
    </Pill>
  );
}

function HealthPanel({ onAddRate }: { onAddRate: (model: string) => void }) {
  const [health, setHealth] = useState<CodeHealth | null>(null);

  useEffect(() => {
    fetch('/api/pulse/code/health')
      .then(r => r.json())
      .then(setHealth)
      .catch(() => {});
  }, []);

  if (!health) return <LoadingSpinner />;

  const allClear = health.unpricedModels.length === 0
    && health.estimatedModels.length === 0
    && health.unattributedOtel.rows === 0
    && health.orphanSessions === 0
    && health.malformedModelsJson === 0;

  if (allClear) {
    return (
      <Notice tone="success">
        All clear: every model priced, every metric attributed.
      </Notice>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Pricing coverage */}
      <Panel
        title="Pricing coverage"
        subtitle="Models seen in the last 30 days with no price (unpriced), or priced only by matching a Bedrock or Vertex model ID to its Anthropic model (estimated at Anthropic list rate)."
        flush
      >
        {health.unpricedModels.length === 0 && health.estimatedModels.length === 0 && (
          <div className="px-4 py-3"><Muted>Every model seen in the last 30 days is priced exactly.</Muted></div>
        )}

        {health.unpricedModels.map((m, i) => (
          <div key={m.model} className={cx('flex items-center gap-3 px-4 py-2.5', i > 0 && 'border-t border-[#F2F2F2]')}>
            <div className="min-w-0 flex-1 flex flex-col gap-0.5">
              <span className="flex items-center gap-2 min-w-0">
                <span className="text-[14px] font-medium text-[#0A0A0A] font-mono truncate">{m.model}</span>
                <Tag tone="warn">Unpriced</Tag>
              </span>
              <span className="text-[13px] text-[#8F8F8F] tabular-nums">
                {m.sessions} session{m.sessions === 1 ? '' : 's'} · {m.totalTokens.toLocaleString()} tokens · unpriced
              </span>
            </div>
            <button type="button" onClick={() => onAddRate(m.model)} className={cx(B.secondary, 'shrink-0')}>
              Add rate
            </button>
          </div>
        ))}
        {health.estimatedModels.map((m, i) => (
          <div
            key={m.model}
            className={cx('flex items-center gap-3 px-4 py-2.5', (i > 0 || health.unpricedModels.length > 0) && 'border-t border-[#F2F2F2]')}
          >
            <div className="min-w-0 flex-1 flex flex-col gap-0.5">
              <span className="flex items-center gap-2 min-w-0">
                <span className="text-[14px] font-medium text-[#0A0A0A] font-mono truncate">{m.model}</span>
                <Tag tone="judged">Estimate</Tag>
              </span>
              <span className="text-[13px] text-[#8F8F8F] tabular-nums">
                {m.sessions} session{m.sessions === 1 ? '' : 's'} · estimated at Anthropic list rate: add exact provider ID for real cost
              </span>
            </div>
            <button type="button" onClick={() => onAddRate(m.model)} className={cx(B.secondary, 'shrink-0')}>
              Add rate
            </button>
          </div>
        ))}
      </Panel>

      {/* Identity */}
      <Panel
        title="Identity"
        subtitle="OTel metric data points from the last 30 days with no resolvable user identity."
        flush
      >
        <Figure
          label="Data points with no user"
          value={health.unattributedOtel.rows}
          tone={health.unattributedOtel.rows > 0 ? 'warn' : 'neutral'}
          sub={health.unattributedOtel.rows > 0 ? (
            <>
              These rows have no matching <code className={inlineCode}>users</code> row for the reporting
              email. Check that the developer&apos;s email is enrolled, or map it under user management.
            </>
          ) : undefined}
        />
      </Panel>

      {/* Pipeline */}
      <Panel
        title="Pipeline"
        subtitle="Ingestion and aggregation health: silent skips, malformed rows, and freshness of each stage."
        flush
      >
        <PanelFigures cols={2}>
          <Figure
            label="Orphan sessions (30d)"
            value={health.orphanSessions}
            tone={health.orphanSessions > 0 ? 'warn' : 'neutral'}
          />
          <Figure
            label="Malformed models_json (30d)"
            value={health.malformedModelsJson}
            tone={health.malformedModelsJson > 0 ? 'warn' : 'neutral'}
          />
        </PanelFigures>
        {([
          { label: 'Aggregator last run', ts: health.aggregatorLastRun, warn: 2 },
          { label: 'Last OTel ingest', ts: health.lastOtelIngest, warn: 2 },
          { label: 'Last meta ingest', ts: health.lastMetaIngest, warn: 26 },
        ] as const).map(r => (
          <div key={r.label} className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-[#F2F2F2]">
            <span className="text-[14px] text-[#333333]">{r.label}</span>
            <StalenessChip timestamp={r.ts} warnAfterHours={r.warn} />
          </div>
        ))}
      </Panel>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

function CodePulseAdminContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const rawTab = searchParams.get('tab');
  const activeTab = rawTab === 'health' ? 'data-quality'
    : rawTab === 'classifier' ? 'tiers'
    : (rawTab as Tab) || 'overview';
  const setTab = (tab: Tab) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', tab);
    router.push(`/admin/code-pulse?${params.toString()}`);
  };

  const [data, setData] = useState<GithubData | null>(null);
  const [repoList, setRepoList] = useState<string[]>([]);
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const { showToast } = useToast();

  const [clf, setClf] = useState<ClassifierData | null>(null);
  const [clfEnabled, setClfEnabled] = useState(true);
  const [clfModel, setClfModel] = useState('claude-haiku-4-5-20251001');
  const [clfIncludePrompt, setClfIncludePrompt] = useState(true);
  const [briefingModel, setBriefingModel] = useState('');
  const [humanTimeCode, setHumanTimeCode] = useState<boolean | null>(null);
  // The organisation briefing model a blank Code briefing model falls back to
  // (getOrgBriefingModel) — named on the page so it never shows a guess.
  const [orgBriefingModel, setOrgBriefingModel] = useState('');
  const [models, setModels] = useState<{ id: string; display_name: string }[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [clfBusy, setClfBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [prefillModel, setPrefillModel] = useState<string | null>(null);

  // Data Quality tab's "Add rate" deep-links here with ?tab=rates&model=<id>.
  const handleAddRate = (model: string) => {
    setPrefillModel(model);
    setTab('rates');
  };

  const load = () => {
    fetch('/api/pulse/code/github')
      .then(r => r.json())
      .then((d: GithubData) => {
        setData(d);
        // Manual multi-repo list: the owner/repo entries the admin tracks.
        const repos = [...new Set(d.mappings.map(m => m.github_repo).filter(Boolean))];
        setRepoList(repos.length > 0 ? repos : ['']);
      })
      .catch(() => {});
  };

  const loadClassifier = () => {
    fetch('/api/pulse/code/classifier')
      .then(r => r.json())
      .then((d: ClassifierData) => {
        setClf(d);
        setClfEnabled(d.enabled);
        setClfModel(d.model);
        setClfIncludePrompt(d.includePrompt);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    loadClassifier();
    fetch('/api/anthropic/models')
      .then(r => r.json())
      .then(d => setModels(d.models ?? []))
      .catch(() => setModels([]))
      .finally(() => setModelsLoading(false));
    fetch('/api/config')
      .then(r => r.json())
      .then(d => {
        setBriefingModel(d.codeBriefingModel ?? ''); setOrgBriefingModel(d.pulseBriefingModel ?? '');
        setHumanTimeCode(effectiveCodeHumanTime(d.humanTimeCodeEnabled, d.humanTimeEnabled));
      })
      .catch(() => {});
  }, []);

  const handleClassifierSave = async () => {
    setClfBusy(true);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          codeClassifierEnabled: String(clfEnabled),
          codeClassifierModel: clfModel,
          codeClassifierIncludePrompt: String(clfIncludePrompt),
          codeBriefingModel: briefingModel,
          // Code's own human-time switch; once saved it no longer follows Cowork's.
          ...(humanTimeCode !== null ? { humanTimeCodeEnabled: humanTimeCode ? 'true' : 'false' } : {}),
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
      showToast('Classifier settings saved', 'success');
      loadClassifier();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Save failed', 'error');
    } finally {
      setClfBusy(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Each tracked owner/repo is stored as its own mapping (repo === github_repo).
      const mappings = [...new Set(repoList.map(r => r.trim()).filter(Boolean))]
        .map(r => ({ repo: r, github_repo: r }));
      const body: Record<string, unknown> = { mappings };
      if (token.trim()) body.token = token.trim();
      const res = await fetch('/api/pulse/code/github', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
      showToast('GitHub overlay settings saved', 'success');
      setToken('');
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await fetch('/api/pulse/code/github', { method: 'POST' });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Sync failed');
      showToast(`Sync complete: ${result.synced} repo(s) synced, ${result.failed} failed`, result.failed > 0 ? 'error' : 'success');
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Sync failed', 'error');
    } finally {
      setSyncing(false);
    }
  };

  if (loading) return (
    <>
      <TopBar title="Developer Pulse admin" subtitle="Judged-layer configuration, GitHub overlay, and module status" />
      <LoadingSpinner />
    </>
  );

  return (
    <>
      <TopBar title="Developer Pulse admin" subtitle="Judged-layer configuration, GitHub overlay, and module status" />
      <PageBody>

        <Tabs
          label="Developer Pulse admin"
          tabs={TABS.map(tab => ({ value: tab.id, label: tab.label }))}
          value={activeTab as Tab}
          onChange={setTab}
        />

        {activeTab === 'overview' && (
          <div className="flex flex-col gap-4">
            {/* Module settings */}
            <Panel title="Module settings" flush>
              <ToggleRow
                first
                label="Session classifier enabled"
                hint="The AI-judged layer: work types and session tiers from telemetry digests. When off, Work Mix and journey grids disappear and Developer Pulse is fully deterministic."
                checked={clfEnabled}
                onChange={setClfEnabled}
              />
              {humanTimeCode !== null && (
                <ToggleRow
                  label="Human time vs Claude time · Code"
                  hint="For each Tier 2 and 3 Code session, an AI estimate of how long an experienced engineer would take by hand, shown beside the measured Claude time on Developer Pulse, and in the weekly digest, Highlights, Reports and the Metrics Connector. Independent of the Cowork switch on Admin → Work Pulse. Off stops new Code estimates and hides the Code figures."
                  checked={humanTimeCode}
                  onChange={setHumanTimeCode}
                />
              )}
              <ToggleRow
                label="Include first prompt"
                hint="Adds the session's first prompt as intent context for classification. Turn off for a metadata-only privacy posture."
                checked={clfIncludePrompt}
                onChange={setClfIncludePrompt}
              />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 px-4 py-4 border-t border-[#F2F2F2]">
                <Field label="Classifier model" hint="Classifies ended sessions (idle 30+ minutes) every 30 minutes.">
                  <ModelSelect value={clfModel} onChange={setClfModel} models={models} loading={modelsLoading} />
                </Field>
                <Field
                  label="Briefing model"
                  hint="Model for the weekly Developer Pulse briefing. Leave on the organisation briefing model (set on Admin → Work Pulse), or pick one for Developer Pulse only."
                >
                  <ModelSelect
                    value={briefingModel}
                    onChange={setBriefingModel}
                    models={models}
                    loading={modelsLoading}
                    followLabel={(() => {
                      const name = orgBriefingModel
                        ? (models.find(m => m.id === orgBriefingModel)?.display_name || orgBriefingModel)
                        : '';
                      return name ? `Use organisation briefing model (${name})` : 'Use organisation briefing model';
                    })()}
                  />
                </Field>
              </div>
              <PanelActions>
                <button type="button" onClick={handleClassifierSave} disabled={clfBusy} className={B.primary}>
                  {clfBusy ? 'Saving...' : 'Save'}
                </button>
              </PanelActions>
            </Panel>

            {/* Module status */}
            {clf && (
              <Panel title="Module status" flush>
                <PanelFigures cols={3}>
                  <Figure label="Briefings generated" value={String(clf.briefings)} />
                  <Figure label="Repos mapped to GitHub" value={String(data?.mappings?.length ?? 0)} />
                  <Figure
                    label="Last GitHub sync"
                    value={
                      <span className="text-[14px] leading-5 font-medium tracking-normal">
                        {data?.lastSync ? new Date(data.lastSync).toLocaleString() : 'Never'}
                      </span>
                    }
                  />
                </PanelFigures>
              </Panel>
            )}
          </div>
        )}

        {activeTab === 'value' && <ValueCalibrationsPanel />}

        {activeTab === 'framework' && <FrameworkAdminPanel />}

        {activeTab === 'rates' && <RatesPanel prefillModel={prefillModel} />}

        {activeTab === 'data-quality' && <HealthPanel onAddRate={handleAddRate} />}

        {activeTab === 'classifier-health' && <CodeClassifierHealthTab />}

        {activeTab === 'tiers' && <CodeClassifierTab />}

        {activeTab === 'github' && (
          <div className="flex flex-col gap-4">
            <Panel title="GitHub access" flush>
              <div className="px-4 py-3 flex flex-col gap-3">
                <p className="m-0 text-[13px] text-[#666666] leading-5">
                  Command Centre stores daily commit and PR counts per repo, plus per-person daily commit counts via
                  commit-author matching (see Commit author mapping below), never commit contents,
                  messages, or SHAs. Alert thresholds live on the Risk Scoring page.
                </p>
                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    type="password"
                    value={token}
                    onChange={e => setToken(e.target.value)}
                    placeholder={data?.tokenConfigured ? 'Token configured. Paste to replace' : 'github_pat_…'}
                    aria-label="GitHub API token"
                    className={cx(B.input, 'flex-1 min-w-[220px]')}
                  />
                  <Pill tone={data?.tokenConfigured ? 'good' : 'neutral'}>
                    {data?.tokenConfigured ? 'Token set' : 'No token'}
                  </Pill>
                  <SecretRemoveButton
                    configKey="githubToken"
                    label="GitHub API token"
                    hasValue={!!data?.tokenConfigured}
                    resetsNote="last GitHub sync time"
                    onRemoved={() => { setToken(''); load(); }}
                  />
                </div>
                <p className="m-0 text-[13px] text-[#8F8F8F] leading-5">
                  Optional for public repos (60 requests/hour unauthenticated). For private repos, a read-only
                  fine-grained PAT with both Contents: read (commit counts) and Pull requests: read (merged-PR
                  counts). Missing the latter doesn&apos;t error, it just silently reports 0 PRs merged forever.
                  Leave blank to keep the current token.
                </p>
              </div>
            </Panel>

            <Panel title="Tracked repositories" flush>
              <div className="px-4 py-3 flex flex-col gap-3">
                <p className="m-0 text-[13px] text-[#666666] leading-5">
                  The GitHub repositories to pull shipping volume for, as <code className={inlineCode}>owner/repo</code>.
                  Add as many as your team ships to. Command Centre syncs daily commit and PR counts per repo, and attributes
                  commits to people by author email/mapping, never commit contents or SHAs.
                </p>
                <div className="flex flex-col gap-2">
                  {repoList.map((repo, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        type="text"
                        value={repo}
                        onChange={e => setRepoList(prev => prev.map((r, j) => (j === i ? e.target.value : r)))}
                        placeholder="owner/repo"
                        aria-label="Repository"
                        className={cx(B.input, 'flex-1 font-mono text-[13px]')}
                      />
                      <button
                        type="button"
                        onClick={() => setRepoList(prev => (prev.length === 1 ? [''] : prev.filter((_, j) => j !== i)))}
                        className="text-[16px] leading-none px-2 text-[#8F8F8F] hover:text-[#B42318] shrink-0"
                        aria-label="Remove repository"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
                <div>
                  <button type="button" onClick={() => setRepoList(prev => [...prev, ''])} className={B.link}>
                    + Add repository
                  </button>
                </div>
              </div>
              <PanelActions>
                <button type="button" onClick={handleSave} disabled={saving} className={B.primary}>
                  {saving ? 'Saving...' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={handleSync}
                  disabled={syncing || (data?.mappings?.length ?? 0) === 0}
                  className={B.secondary}
                >
                  {syncing ? 'Syncing…' : 'Sync now'}
                </button>
                <span className="text-[13px] text-[#8F8F8F]">
                  {data?.lastSync ? `Last sync: ${new Date(data.lastSync).toLocaleString()}` : 'Never synced'} · automatic every 12 hours
                </span>
              </PanelActions>
            </Panel>

            <GithubIdentityPanel onToast={showToast} />
          </div>
        )}

      </PageBody>
    </>
  );
}

export default function CodePulseAdminPage() {
  return (
    <Suspense fallback={<LoadingSpinner />}>
      <CodePulseAdminContent />
    </Suspense>
  );
}
