// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { useToast } from '@/components/shared/ToastProvider';
import SecretRemoveButton from '@/components/admin/SecretRemoveButton';
import { PageBody, Panel, Notice, SubHead, Dot, SEVERITY_COLOR, B, cx } from '@/components/precision/ui';


/** On/off switch: black when on, #DADADA when off. A real switch button; `onChange` gets the new value. */
function Switch({ checked, onChange, disabled, label }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-5 w-[34px] shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#245BF3]/30 disabled:opacity-50 disabled:cursor-not-allowed',
        checked ? 'bg-[#0A0A0A]' : 'bg-[#DADADA]',
      )}
    >
      <span
        aria-hidden="true"
        className={cx('absolute top-[3px] h-3.5 w-3.5 rounded-full bg-white transition-[left]', checked ? 'left-[17px]' : 'left-[3px]')}
      />
    </button>
  );
}

/** A form field: label above the control, 12px grey hint below. */
function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-[14px] font-medium text-[#0A0A0A] min-w-0">
      {label}
      <span className="font-normal">{children}</span>
      {hint && <span className="text-[13px] font-normal text-[#8F8F8F] leading-5">{hint}</span>}
    </label>
  );
}

const DEFAULT_SEVERITY: Record<string, string> = {
  low: 'Informational. Something to be aware of. A single PII flag, a user trying a new surface.',
  medium: 'Worth a look. A pattern forming: multiple PII flags from the same user, unusual access patterns.',
  high: 'Needs attention. Systematic issues, repeated policy violations, credential-like content in prompts.',
  critical: 'Actual incident. Data exfiltration patterns, widespread misuse, real security breach indicators.',
};

export default function AdminRiskPage() {
  // Threshold state
  const [tokenMultiplier, setTokenMultiplier] = useState('3');
  const [fileAccessLimit, setFileAccessLimit] = useState('50');
  const [inactivityDays, setInactivityDays] = useState('14');
  const [sensitivity, setSensitivity] = useState('balanced');

  // Alert type toggles
  const [anomalyEnabled, setAnomalyEnabled] = useState(true);
  const [policyEnabled, setPolicyEnabled] = useState(true);
  const [adoptionEnabled, setAdoptionEnabled] = useState(true);
  const [riskEnabled, setRiskEnabled] = useState(true);
  const [pulseCapabilityEnabled, setPulseCapabilityEnabled] = useState(false);
  const [financeDriftEnabled, setFinanceDriftEnabled] = useState(true);
  const [useCaseAlertEnabled, setUseCaseAlertEnabled] = useState(true);

  // Developer Pulse alert toggles (deterministic — evaluated on the hourly cycle)
  const [codeCostSpikeEnabled, setCodeCostSpikeEnabled] = useState(true);
  const [codeModelPolicyEnabled, setCodeModelPolicyEnabled] = useState(false);
  const [codeRepoExposureEnabled, setCodeRepoExposureEnabled] = useState(false);
  const [codeFrictionEnabled, setCodeFrictionEnabled] = useState(false);

  // File upload alert patterns (comma-separated org globs)
  const [fileUploadPatterns, setFileUploadPatterns] = useState('');

  // High-Priority Alerts -> Slack
  const [alertsSlackEnabled, setAlertsSlackEnabled] = useState(false);
  const [alertsSlackWebhookUrl, setAlertsSlackWebhookUrl] = useState('');
  const [alertsSlackTesting, setAlertsSlackTesting] = useState(false);
  const [alertsSlackTestResult, setAlertsSlackTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  // Developer Pulse alert thresholds
  const [codeCostFloor, setCodeCostFloor] = useState('100');
  const [codeFrictionPct, setCodeFrictionPct] = useState('25');
  const [codeModelAllowlist, setCodeModelAllowlist] = useState('');
  const [codeRepoPatterns, setCodeRepoPatterns] = useState('');

  // Severity descriptions
  const [severityLow, setSeverityLow] = useState(DEFAULT_SEVERITY.low);
  const [severityMedium, setSeverityMedium] = useState(DEFAULT_SEVERITY.medium);
  const [severityHigh, setSeverityHigh] = useState(DEFAULT_SEVERITY.high);
  const [severityCritical, setSeverityCritical] = useState(DEFAULT_SEVERITY.critical);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(data => {
        if (data.riskTokenMultiplier) setTokenMultiplier(String(data.riskTokenMultiplier));
        if (data.riskFileAccessLimit) setFileAccessLimit(String(data.riskFileAccessLimit));
        if (data.riskInactivityDays) setInactivityDays(String(data.riskInactivityDays));
        if (data.riskSensitivity) setSensitivity(data.riskSensitivity);

        // Booleans: check explicitly for false (defaults are true)
        if (data.riskAlertAnomalyEnabled !== undefined) setAnomalyEnabled(data.riskAlertAnomalyEnabled);
        if (data.riskAlertPolicyEnabled !== undefined) setPolicyEnabled(data.riskAlertPolicyEnabled);
        if (data.riskAlertAdoptionEnabled !== undefined) setAdoptionEnabled(data.riskAlertAdoptionEnabled);
        if (data.riskAlertRiskEnabled !== undefined) setRiskEnabled(data.riskAlertRiskEnabled);
        if (data.riskAlertPulseCapabilityEnabled !== undefined) setPulseCapabilityEnabled(data.riskAlertPulseCapabilityEnabled);
        // riskAlertFinanceDriftEnabled / riskAlertUseCaseEnabled are stored (and
        // returned by GET /api/config) as the raw 'true'/'false' string, not a
        // JSON boolean — compare against the string, don't assign it directly.
        if (data.riskAlertFinanceDriftEnabled !== undefined) setFinanceDriftEnabled(data.riskAlertFinanceDriftEnabled !== 'false');
        if (data.riskAlertUseCaseEnabled !== undefined) setUseCaseAlertEnabled(data.riskAlertUseCaseEnabled !== 'false');
        if (data.codeAlertCostSpikeEnabled !== undefined) setCodeCostSpikeEnabled(data.codeAlertCostSpikeEnabled);
        if (data.codeAlertModelPolicyEnabled !== undefined) setCodeModelPolicyEnabled(data.codeAlertModelPolicyEnabled);
        if (data.codeAlertRepoExposureEnabled !== undefined) setCodeRepoExposureEnabled(data.codeAlertRepoExposureEnabled);
        if (data.codeAlertFrictionEnabled !== undefined) setCodeFrictionEnabled(data.codeAlertFrictionEnabled);
        if (data.codeCostSpikeFloorUsd) setCodeCostFloor(String(data.codeCostSpikeFloorUsd));
        if (data.codeFrictionThreshold) setCodeFrictionPct(String(Math.round(data.codeFrictionThreshold * 100)));
        try { if (data.codeModelAllowlist) setCodeModelAllowlist((JSON.parse(data.codeModelAllowlist) as string[]).join(', ')); } catch { /* leave blank */ }
        try { if (data.codeSensitiveRepoPatterns) setCodeRepoPatterns((JSON.parse(data.codeSensitiveRepoPatterns) as string[]).join(', ')); } catch { /* leave blank */ }
        try { if (data.fileUploadAlertPatterns) setFileUploadPatterns((JSON.parse(data.fileUploadAlertPatterns) as string[]).join(', ')); } catch { /* leave blank */ }
        if (data.alertsSlackEnabled !== undefined) setAlertsSlackEnabled(data.alertsSlackEnabled);
        if (data.alertsSlackWebhookUrl) setAlertsSlackWebhookUrl(data.alertsSlackWebhookUrl);

        if (data.riskSeverityLowDesc) setSeverityLow(data.riskSeverityLowDesc);
        if (data.riskSeverityMediumDesc) setSeverityMedium(data.riskSeverityMediumDesc);
        if (data.riskSeverityHighDesc) setSeverityHigh(data.riskSeverityHighDesc);
        if (data.riskSeverityCriticalDesc) setSeverityCritical(data.riskSeverityCriticalDesc);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const allDisabled = !anomalyEnabled && !policyEnabled && !adoptionEnabled && !riskEnabled && !pulseCapabilityEnabled
    && !financeDriftEnabled && !useCaseAlertEnabled;

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          riskTokenMultiplier: tokenMultiplier,
          riskFileAccessLimit: fileAccessLimit,
          riskInactivityDays: inactivityDays,
          riskSensitivity: sensitivity,
          riskAlertAnomalyEnabled: String(anomalyEnabled),
          riskAlertPolicyEnabled: String(policyEnabled),
          riskAlertAdoptionEnabled: String(adoptionEnabled),
          riskAlertRiskEnabled: String(riskEnabled),
          riskAlertPulseCapabilityEnabled: String(pulseCapabilityEnabled),
          riskAlertFinanceDriftEnabled: String(financeDriftEnabled),
          riskAlertUseCaseEnabled: String(useCaseAlertEnabled),
          codeAlertCostSpikeEnabled: String(codeCostSpikeEnabled),
          codeAlertModelPolicyEnabled: String(codeModelPolicyEnabled),
          codeAlertRepoExposureEnabled: String(codeRepoExposureEnabled),
          codeAlertFrictionEnabled: String(codeFrictionEnabled),
          codeCostSpikeFloorUsd: codeCostFloor,
          codeFrictionThreshold: String((parseFloat(codeFrictionPct) || 25) / 100),
          codeModelAllowlist: JSON.stringify(codeModelAllowlist.split(',').map(s => s.trim()).filter(Boolean)),
          codeSensitiveRepoPatterns: JSON.stringify(codeRepoPatterns.split(',').map(s => s.trim()).filter(Boolean)),
          fileUploadAlertPatterns: JSON.stringify(fileUploadPatterns.split(',').map(s => s.trim()).filter(Boolean)),
          alertsSlackEnabled: String(alertsSlackEnabled),
          alertsSlackWebhookUrl,
          riskSeverityLowDesc: severityLow,
          riskSeverityMediumDesc: severityMedium,
          riskSeverityHighDesc: severityHigh,
          riskSeverityCriticalDesc: severityCritical,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Save failed');
      }
      showToast('Risk scoring settings saved', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleSendAlertsSlackTest = async () => {
    setAlertsSlackTesting(true);
    setAlertsSlackTestResult(null);
    try {
      const res = await fetch('/api/admin/alerts-slack/test', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setAlertsSlackTestResult({ ok: true });
      } else {
        setAlertsSlackTestResult({ ok: false, error: data.error || 'Test failed' });
      }
    } catch {
      setAlertsSlackTestResult({ ok: false, error: 'Test failed' });
    } finally {
      setAlertsSlackTesting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1">
        <TopBar title="Risk Scoring" />
        <div className="flex items-center justify-center py-20">
          <LoadingSpinner />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1">
      <TopBar title="Risk Scoring" />
      <PageBody className="max-w-[1000px]">

        {/* Section 1: Detection Sensitivity */}
        <Panel title="Detection sensitivity" subtitle="Controls the overall sensitivity of anomaly detection. This adjusts your numeric thresholds at runtime.">
          <Field
            label="Sensitivity preset"
            hint="Conservative multiplies your thresholds by 1.5× (higher bar, fewer alerts). Aggressive multiplies by 0.6× (lower bar, more alerts). Your saved threshold values remain unchanged."
          >
            <select
              value={sensitivity}
              onChange={e => setSensitivity(e.target.value)}
              className={cx(B.select, 'text-[14px] w-full sm:w-80')}
            >
              <option value="conservative">Conservative: fewer alerts (1.5× thresholds)</option>
              <option value="balanced">Balanced: default sensitivity</option>
              <option value="aggressive">Aggressive: more alerts (0.6× thresholds)</option>
            </select>
          </Field>
        </Panel>

        {/* Section 2: Threshold Configuration */}
        <Panel title="Threshold configuration" subtitle="Base thresholds for anomaly detection. The sensitivity preset above adjusts these at runtime.">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field
              label="Token consumption multiplier"
              hint={<>Flag when a user&apos;s session token count exceeds this multiple of their 7-day average</>}
            >
              <input
                type="number"
                min="1"
                value={tokenMultiplier}
                onChange={e => setTokenMultiplier(e.target.value)}
                className={cx(B.input, 'w-32')}
              />
            </Field>
            <Field label="File access limit per session" hint="Flag Cowork sessions accessing more than this many files">
              <input
                type="number"
                min="1"
                value={fileAccessLimit}
                onChange={e => setFileAccessLimit(e.target.value)}
                className={cx(B.input, 'w-32')}
              />
            </Field>
            <Field label="Inactivity threshold (days)" hint="Flag users inactive for this many days after onboarding">
              <input
                type="number"
                min="1"
                value={inactivityDays}
                onChange={e => setInactivityDays(e.target.value)}
                className={cx(B.input, 'w-32')}
              />
            </Field>
          </div>
        </Panel>

        {/* Section 3: Alert Type Toggles */}
        <Panel title="Alert types" subtitle="Enable or disable specific categories of alerts." flush>
          {allDisabled && (
            <div className="px-4 pt-3">
              <Notice tone="warn">
                <span className="font-medium">All alert types are disabled. Anomaly detection will not generate any alerts.</span>
              </Notice>
            </div>
          )}

          <div className={allDisabled ? 'mt-1' : undefined}>
            {[
              { label: 'Anomaly detection', desc: 'Unusual usage patterns, token spikes, file access anomalies', value: anomalyEnabled, setter: setAnomalyEnabled },
              { label: 'Policy violations', desc: 'Acceptable use policy breaches, credential-like content', value: policyEnabled, setter: setPolicyEnabled },
              { label: 'Adoption concerns', desc: 'Inactive users, shallow engagement, declining usage', value: adoptionEnabled, setter: setAdoptionEnabled },
              { label: 'Risk alerts', desc: 'Data exfiltration patterns, security breach indicators', value: riskEnabled, setter: setRiskEnabled },
              { label: 'Pulse capability confirmations', desc: 'Alert when a Work Pulse capability creation event is confirmed. Off by default, as these are already visible in the Pulse Capability Log.', value: pulseCapabilityEnabled, setter: setPulseCapabilityEnabled },
              { label: 'Finance reconciliation drift', desc: 'Command Centre\'s own spend estimate diverges from Anthropic\'s reported cost by more than the configured threshold (FinOps). Deterministic, no AI judgement.', value: financeDriftEnabled, setter: setFinanceDriftEnabled },
              { label: 'Use case at-risk', desc: 'A tracked use case that was piloting or adopted has gone quiet for several weeks (Use Cases lifecycle tracker). Deterministic, no AI judgement.', value: useCaseAlertEnabled, setter: setUseCaseAlertEnabled },
              { label: 'Developer Pulse: daily spend limit', desc: 'A user\'s Claude Code spend in the last 24 hours is over the daily limit below. Over twice the limit is high and goes to Slack. Deterministic, no AI judgement.', value: codeCostSpikeEnabled, setter: setCodeCostSpikeEnabled },
              { label: 'Developer Pulse: model policy', desc: 'A model not on the approved list was used in Claude Code. Requires an allowlist in config (code_model_allowlist). Off by default.', value: codeModelPolicyEnabled, setter: setCodeModelPolicyEnabled },
              { label: 'Developer Pulse: sensitive repo', desc: 'Claude Code activity in a repo matching a sensitive-path pattern (code_sensitive_repo_patterns). Off by default.', value: codeRepoExposureEnabled, setter: setCodeRepoExposureEnabled },
              { label: 'Developer Pulse: high friction', desc: 'Over a quarter of tool actions failed in a session: a coaching signal. Off by default; visible on the Developer Pulse Overview regardless.', value: codeFrictionEnabled, setter: setCodeFrictionEnabled },
            ].map(item => (
              <div key={item.label} className="flex items-start gap-4 px-4 py-3 border-t border-[#F2F2F2] first:border-t-0">
                <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                  <span className="text-[14px] font-medium text-[#0A0A0A]">{item.label}</span>
                  <span className="text-[13px] text-[#666666] leading-5">{item.desc}</span>
                </div>
                <Switch checked={item.value} onChange={item.setter} label={item.label} />
              </div>
            ))}
          </div>
        </Panel>

        {/* Section 3b: Developer Pulse Alert Settings */}
        <Panel title="Developer Pulse alert settings" subtitle="Thresholds for the deterministic Developer Pulse alerts. Evaluated hourly. Changes take effect on the next cycle, no restart needed.">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <Field label="Daily spend limit ($)" hint="Alert when someone's Claude Code spend in the last 24 hours is over this. Over twice this is high and goes to Slack">
              <input
                type="number" min="0" step="1" value={codeCostFloor}
                onChange={e => setCodeCostFloor(e.target.value)}
                className={cx(B.input, 'w-full')}
              />
            </Field>
            <Field label="Friction threshold (%)" hint={<>Alert when more than this share of a session&apos;s tool actions fail</>}>
              <input
                type="number" min="1" max="100" step="1" value={codeFrictionPct}
                onChange={e => setCodeFrictionPct(e.target.value)}
                className={cx(B.input, 'w-full')}
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Approved models (comma-separated)" hint="Leave empty to disable the model policy check entirely">
              <input
                type="text" value={codeModelAllowlist} placeholder="claude-fable-5, claude-haiku-4-5"
                onChange={e => setCodeModelAllowlist(e.target.value)}
                className={cx(B.input, 'w-full')}
              />
            </Field>
            <Field label="Sensitive repo patterns (comma-separated)" hint="Case-insensitive substring match against repo names">
              <input
                type="text" value={codeRepoPatterns} placeholder="payroll, secrets, hr-"
                onChange={e => setCodeRepoPatterns(e.target.value)}
                className={cx(B.input, 'w-full')}
              />
            </Field>
          </div>
        </Panel>

        {/* Section 3c: File Upload Alert Settings */}
        <Panel title="File upload alert settings">
          <p className="m-0 mb-4 text-[13px] text-[#666666] leading-5">
            Alert when a user uploads a file to a Cowork session whose name matches a glob pattern.
            Built-in patterns below are always active. Add org-specific patterns (e.g. <code className="bg-[#F2F2F2] px-1 rounded-[6px] text-[12px] font-mono">*.xlsx</code>, <code className="bg-[#F2F2F2] px-1 rounded-[6px] text-[12px] font-mono">*payroll*</code>) to extend coverage.
          </p>

          {/* Built-in read-only patterns */}
          <div className="mb-4">
            <SubHead>Built-in patterns (always on)</SubHead>
            <div className="flex flex-wrap gap-x-3 gap-y-2">
              {[
                { p: '*.pem', s: 'critical' }, { p: '*.key', s: 'critical' }, { p: '*.p12', s: 'critical' },
                { p: '*.pfx', s: 'critical' }, { p: '*.ppk', s: 'critical' }, { p: 'id_rsa', s: 'critical' },
                { p: 'id_ed25519', s: 'critical' }, { p: '.env', s: 'critical' }, { p: '.env.*', s: 'critical' },
                { p: '*.env', s: 'critical' }, { p: '*secret*', s: 'high' }, { p: '*password*', s: 'high' },
                { p: '*credential*', s: 'high' }, { p: '*private_key*', s: 'high' },
                { p: '*.sql', s: 'high' }, { p: '*.dump', s: 'high' }, { p: '*.bak', s: 'medium' },
              ].map(({ p, s }) => (
                <span key={p} title={`${s} severity`} className="inline-flex items-center gap-1.5 border border-[#EAEAEA] rounded-[6px] px-1.5 py-0.5">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: SEVERITY_COLOR[s] }} aria-hidden="true" />
                  <span className="font-mono text-[12px] text-[#333333]">{p}</span>
                  <span className="sr-only">({s})</span>
                </span>
              ))}
            </div>
            <div className="flex flex-wrap gap-4 mt-2.5">
              <Dot color={SEVERITY_COLOR.critical}><span className="text-[#666666]">Critical</span></Dot>
              <Dot color={SEVERITY_COLOR.high}><span className="text-[#666666]">High</span></Dot>
              <Dot color={SEVERITY_COLOR.medium}><span className="text-[#666666]">Medium</span></Dot>
            </div>
          </div>

          {/* Org patterns */}
          <Field
            label="Org-specific patterns (comma-separated)"
            hint="Case-insensitive glob (* matches any sequence). All org patterns fire as high-severity policy alerts with 24h deduplication."
          >
            <input
              type="text"
              value={fileUploadPatterns}
              placeholder="*.xlsx, *payroll*, *board-minutes*"
              onChange={e => setFileUploadPatterns(e.target.value)}
              className={cx(B.input, 'w-full')}
            />
          </Field>
        </Panel>

        {/* Section 3d: High-Priority Alerts -> Slack */}
        <Panel title="High-priority alerts → Slack" flush>
          <div className="px-4 py-3 flex flex-col gap-2 text-[13px] text-[#666666] leading-5">
            <p className="m-0">
              Checked hourly: any <code className="bg-[#F2F2F2] px-1 rounded-[6px] text-[12px] font-mono">high</code> or <code className="bg-[#F2F2F2] px-1 rounded-[6px] text-[12px] font-mono">critical</code> severity alert found since the last check is pushed to Slack via an incoming webhook. Save the webhook URL first, then use &quot;Send test&quot; to verify before enabling.
            </p>
            <p className="m-0">
              Alert titles and explanations (which may name the affected user) are posted to whoever can read the target Slack channel.
            </p>
          </div>

          <div className="flex items-start gap-4 px-4 py-3 border-t border-[#F2F2F2]">
            <span className="flex-1 text-[14px] font-medium text-[#0A0A0A]">Enable high-priority Slack alerts</span>
            <Switch
              checked={alertsSlackEnabled}
              onChange={setAlertsSlackEnabled}
              label="Enable high-priority Slack alerts"
            />
          </div>

          <div className="px-4 py-3 border-t border-[#F2F2F2]">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="alerts-slack-webhook" className="text-[14px] font-medium text-[#0A0A0A]">Slack webhook URL</label>
              <div className="flex gap-2">
                <input
                  id="alerts-slack-webhook"
                  type="password"
                  value={alertsSlackWebhookUrl}
                  onChange={(e) => setAlertsSlackWebhookUrl(e.target.value)}
                  className={cx(B.input, 'flex-1 min-w-0 font-mono')}
                  placeholder="https://hooks.slack.com/services/..."
                />
                <SecretRemoveButton
                  configKey="alertsSlackWebhookUrl"
                  label="High-priority alerts Slack webhook"
                  hasValue={alertsSlackWebhookUrl.length > 0}
                  onRemoved={() => setAlertsSlackWebhookUrl('')}
                />
              </div>
              <span className="text-[13px] text-[#8F8F8F]">A separate webhook from the Weekly Digest&apos;s, so alerts can target a different channel.</span>
            </div>

            {alertsSlackTestResult && (
              <div className="mt-3">
                <Notice tone={alertsSlackTestResult.ok ? 'success' : 'error'}>
                  {alertsSlackTestResult.ok ? 'Test message sent. Check the Slack channel.' : alertsSlackTestResult.error}
                </Notice>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 px-4 py-3 border-t border-[#F2F2F2]">
            <button
              type="button"
              onClick={handleSendAlertsSlackTest}
              disabled={alertsSlackTesting}
              className={B.secondary}
            >
              {alertsSlackTesting ? 'Sending...' : 'Send test'}
            </button>
          </div>
        </Panel>

        {/* Section 4: Severity Calibration */}
        <Panel title="Severity calibration" subtitle="Define what each severity level means. The AI model uses these descriptions to calibrate alert severity.">
          <div className="flex flex-col gap-4">
            {[
              { key: 'low', label: 'Low', value: severityLow, setter: setSeverityLow },
              { key: 'medium', label: 'Medium', value: severityMedium, setter: setSeverityMedium },
              { key: 'high', label: 'High', value: severityHigh, setter: setSeverityHigh },
              { key: 'critical', label: 'Critical', value: severityCritical, setter: setSeverityCritical },
            ].map(item => (
              <div key={item.key} className="flex flex-col gap-1.5">
                <label htmlFor={`severity-${item.key}`} className="text-[14px] font-medium text-[#0A0A0A]">
                  <Dot color={SEVERITY_COLOR[item.key]}><span className="text-[14px]">{item.label}</span></Dot>
                </label>
                <textarea
                  id={`severity-${item.key}`}
                  value={item.value}
                  onChange={e => item.setter(e.target.value)}
                  rows={2}
                  className={cx(B.input, 'w-full resize-none')}
                />
              </div>
            ))}
          </div>
        </Panel>

        {/* Save Button */}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className={B.primary}
          >
            {saving ? 'Saving...' : 'Save risk settings'}
          </button>
        </div>
      </PageBody>
    </div>
  );
}
