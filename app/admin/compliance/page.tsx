// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import TopBar from '@/components/layout/TopBar';
import { PageBody, Panel, Bar, Dot, Muted, B, C, cx, type Tone } from '@/components/precision/ui';
import { Switch, ToggleRow, Field } from '@/components/admin/precision-admin';
import { useToast } from '@/components/shared/ToastProvider';

export default function AdminCompliancePage() {
  const { showToast } = useToast();

  const [dpiaCompleted, setDpiaCompleted] = useState(false);
  const [dpiaDate, setDpiaDate] = useState('');
  const [dataProtectionOfficer, setDataProtectionOfficer] = useState('');
  const [aiActRiskTier, setAiActRiskTier] = useState('not-assessed');
  const [aiActTransparencyNotice, setAiActTransparencyNotice] = useState(false);
  const [isoControlOwner, setIsoControlOwner] = useState('');
  const [isoCertificationStatus, setIsoCertificationStatus] = useState('not-started');
  const [iso42001Owner, setIso42001Owner] = useState('');
  const [iso42001AssessmentStatus, setIso42001AssessmentStatus] = useState('not-started');
  const [gdprApplicable, setGdprApplicable] = useState(true);
  const [lgpdApplicable, setLgpdApplicable] = useState(false);
  const [dataProtectionEncarregado, setDataProtectionEncarregado] = useState('');
  const [ripdCompleted, setRipdCompleted] = useState(false);
  const [ripdDate, setRipdDate] = useState('');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(data => {
        if (data.dpiaCompleted !== undefined) setDpiaCompleted(data.dpiaCompleted === true || data.dpiaCompleted === 'true');
        if (data.dpiaDate) setDpiaDate(String(data.dpiaDate));
        if (data.dataProtectionOfficer) setDataProtectionOfficer(String(data.dataProtectionOfficer));
        if (data.aiActRiskTier) setAiActRiskTier(String(data.aiActRiskTier));
        if (data.aiActTransparencyNotice !== undefined) setAiActTransparencyNotice(data.aiActTransparencyNotice === true || data.aiActTransparencyNotice === 'true');
        if (data.isoControlOwner) setIsoControlOwner(String(data.isoControlOwner));
        if (data.isoCertificationStatus) setIsoCertificationStatus(String(data.isoCertificationStatus));
        if (data.iso42001Owner) setIso42001Owner(String(data.iso42001Owner));
        if (data.iso42001AssessmentStatus) setIso42001AssessmentStatus(String(data.iso42001AssessmentStatus));
        if (data.gdprApplicable !== undefined) setGdprApplicable(data.gdprApplicable === true || data.gdprApplicable === 'true');
        if (data.lgpdApplicable !== undefined) setLgpdApplicable(data.lgpdApplicable === true || data.lgpdApplicable === 'true');
        if (data.dataProtectionEncarregado) setDataProtectionEncarregado(String(data.dataProtectionEncarregado));
        if (data.ripdCompleted !== undefined) setRipdCompleted(data.ripdCompleted === true || data.ripdCompleted === 'true');
        if (data.ripdDate) setRipdDate(String(data.ripdDate));
      })
      .catch(() => showToast('Failed to load compliance settings', 'error'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load the settings once, on first render
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dpiaCompleted: String(dpiaCompleted),
          dpiaDate,
          dataProtectionOfficer,
          aiActRiskTier,
          aiActTransparencyNotice: String(aiActTransparencyNotice),
          isoControlOwner,
          isoCertificationStatus,
          iso42001Owner,
          iso42001AssessmentStatus,
          gdprApplicable: String(gdprApplicable),
          lgpdApplicable: String(lgpdApplicable),
          dataProtectionEncarregado,
          ripdCompleted: String(ripdCompleted),
          ripdDate,
        }),
      });
      if (!res.ok) throw new Error('Save failed');
      showToast('Compliance declarations saved', 'success');
    } catch {
      showToast('Failed to save compliance declarations', 'error');
    } finally {
      setSaving(false);
    }
  };

  // Compute completeness
  const fieldStatuses = [
    ...(gdprApplicable ? [
      { label: 'DPO assigned', done: !!dataProtectionOfficer.trim() },
      { label: 'DPIA completed', done: dpiaCompleted },
      { label: 'DPIA date set', done: !!(dpiaCompleted && dpiaDate) },
    ] : []),
    ...(lgpdApplicable ? [
      { label: 'Encarregado assigned', done: !!dataProtectionEncarregado.trim() },
      { label: 'RIPD completed', done: ripdCompleted },
      { label: 'RIPD date set', done: !!(ripdCompleted && ripdDate) },
    ] : []),
    { label: 'AI Act risk assessed', done: aiActRiskTier !== 'not-assessed' },
    { label: 'Transparency notice', done: aiActTransparencyNotice },
    { label: 'ISMS control owner', done: !!isoControlOwner.trim() },
    { label: 'ISO certification status set', done: isoCertificationStatus !== 'not-started' },
    { label: 'AIMS owner', done: !!iso42001Owner.trim() },
    { label: 'ISO 42001 assessment set', done: iso42001AssessmentStatus !== 'not-started' },
  ];
  const completedCount = fieldStatuses.filter(f => f.done).length;
  const total = fieldStatuses.length;
  const progressPct = Math.round((completedCount / total) * 100);
  const progressTone: Tone =
    completedCount === total
      ? 'good'
      : completedCount >= 4
      ? 'warn'
      : 'bad';

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-[#8F8F8F] text-[14px]">
        Loading...
      </div>
    );
  }

  /** "Applies to this organisation" switch, shown in a framework panel's header. */
  const appliesSwitch = (checked: boolean, onChange: (next: boolean) => void, framework: string) => (
    <span className="inline-flex items-center gap-2 text-[13px] text-[#666666]">
      Applies to this organisation
      <Switch checked={checked} onChange={onChange} label={`${framework} applies to this organisation`} />
    </span>
  );

  return (
    <div>
      <TopBar
        title="Compliance"
        subtitle="GDPR, LGPD, EU AI Act, ISO 27001, and ISO 42001 declarations"
      />

      <PageBody>

        {/* Declaration status */}
        <Panel
          title="Declaration status"
          subtitle="Review your declarations regularly to maintain compliance."
          right={<span className="text-[13px] text-[#666666] tabular-nums">{completedCount} of {total} fields completed</span>}
        >
          {/* Completeness indicator */}
          <div className="flex items-center gap-3 mb-4">
            <div className="flex-1"><Bar pct={progressPct} tone={progressTone} height={6} /></div>
            <span className="text-[14px] font-semibold text-[#0A0A0A] tabular-nums">{progressPct}%</span>
          </div>

          {/* Field status grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
            {fieldStatuses.map(({ label, done }) => (
              <div key={label} className="flex items-center gap-2">
                <Dot color={done ? C.good : C.medium}>
                  <span className={done ? 'text-[#0A0A0A] text-[14px]' : 'text-[#8F8F8F] text-[14px]'}>{label}</span>
                </Dot>
                <span className="sr-only">{done ? 'complete' : 'missing'}</span>
              </div>
            ))}
          </div>
        </Panel>

        {/* GDPR */}
        <Panel title="GDPR" right={appliesSwitch(gdprApplicable, setGdprApplicable, 'GDPR')} flush>
          {gdprApplicable ? (
            <>
              <div className="px-4 py-3">
                <Field label="Data protection officer">
                  <input
                    type="text"
                    value={dataProtectionOfficer}
                    onChange={e => setDataProtectionOfficer(e.target.value)}
                    className={cx(B.input, 'w-full')}
                    placeholder="Name and contact (e.g. Jane Smith, jane@example.com)"
                  />
                </Field>
              </div>
              <ToggleRow label="DPIA completed" checked={dpiaCompleted} onChange={setDpiaCompleted}>
                {dpiaCompleted && (
                  <input
                    type="date"
                    value={dpiaDate}
                    onChange={e => setDpiaDate(e.target.value)}
                    aria-label="DPIA date"
                    className={cx(B.input, 'mt-1.5 w-fit')}
                  />
                )}
              </ToggleRow>
            </>
          ) : (
            <div className="px-4 py-3"><Muted>Marked as not applicable: no GDPR gaps will be raised and GDPR is excluded from the completeness score.</Muted></div>
          )}
        </Panel>

        {/* LGPD */}
        <Panel title="LGPD (Lei 13.709/2018)" right={appliesSwitch(lgpdApplicable, setLgpdApplicable, 'LGPD')} flush>
          {lgpdApplicable ? (
            <>
              <div className="px-4 py-3">
                <Field label="Encarregado (data protection officer, Art. 41)">
                  <input
                    type="text"
                    value={dataProtectionEncarregado}
                    onChange={e => setDataProtectionEncarregado(e.target.value)}
                    className={cx(B.input, 'w-full')}
                    placeholder="Name and contact (e.g. João Silva, joao@corp.com.br)"
                  />
                </Field>
              </div>
              <ToggleRow label="RIPD completed (Relatório de Impacto, Art. 38)" checked={ripdCompleted} onChange={setRipdCompleted}>
                {ripdCompleted && (
                  <input
                    type="date"
                    value={ripdDate}
                    onChange={e => setRipdDate(e.target.value)}
                    aria-label="RIPD date"
                    className={cx(B.input, 'mt-1.5 w-fit')}
                  />
                )}
              </ToggleRow>
              <div className="px-4 py-3 border-t border-[#F2F2F2]">
                <Muted>Supervisory authority: ANPD. Titular rights (Art. 18) are served by the existing data subject export/erasure tooling.</Muted>
              </div>
            </>
          ) : (
            <div className="px-4 py-3"><Muted>Marked as not applicable: no LGPD gaps will be raised and LGPD is excluded from the completeness score.</Muted></div>
          )}
        </Panel>

        {/* EU AI Act */}
        <Panel title="EU AI Act (Regulation 2024/1689)" flush>
          <div className="px-4 py-3 grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Risk classification">
              <select
                value={aiActRiskTier}
                onChange={e => setAiActRiskTier(e.target.value)}
                className={cx(B.select, 'w-full text-[14px]')}
              >
                <option value="not-assessed">Not assessed</option>
                <option value="minimal">Minimal risk</option>
                <option value="limited">Limited risk</option>
                <option value="high">High risk</option>
                <option value="unacceptable">Unacceptable risk</option>
              </select>
            </Field>
          </div>
          <ToggleRow
            label="Art. 50 transparency notice published"
            checked={aiActTransparencyNotice}
            onChange={setAiActTransparencyNotice}
          />
        </Panel>

        {/* ISO 27001 */}
        <Panel title="ISO 27001:2022">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="ISMS control owner">
              <input
                type="text"
                value={isoControlOwner}
                onChange={e => setIsoControlOwner(e.target.value)}
                className={cx(B.input, 'w-full')}
                placeholder="Team or individual responsible (e.g. IT Security Team)"
              />
            </Field>
            <Field label="Certification status">
              <select
                value={isoCertificationStatus}
                onChange={e => setIsoCertificationStatus(e.target.value)}
                className={cx(B.select, 'w-full text-[14px]')}
              >
                <option value="not-started">Not started</option>
                <option value="in-progress">In progress</option>
                <option value="certified">Certified</option>
                <option value="lapsed">Lapsed</option>
              </select>
            </Field>
          </div>
        </Panel>

        {/* ISO/IEC 42001:2023 */}
        <Panel title="ISO/IEC 42001:2023">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="AIMS owner">
              <input
                type="text"
                value={iso42001Owner}
                onChange={e => setIso42001Owner(e.target.value)}
                className={cx(B.input, 'w-full')}
                placeholder="Team or individual responsible (e.g. AI Governance Lead)"
              />
            </Field>
            <Field label="Assessment status">
              <select
                value={iso42001AssessmentStatus}
                onChange={e => setIso42001AssessmentStatus(e.target.value)}
                className={cx(B.select, 'w-full text-[14px]')}
              >
                <option value="not-started">Not started</option>
                <option value="in-progress">In progress</option>
                <option value="assessed">Assessed</option>
                <option value="certified">Certified</option>
              </select>
            </Field>
          </div>
        </Panel>

        {/* Save */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className={B.primary}
          >
            {saving ? 'Saving…' : 'Save declarations'}
          </button>
        </div>

      </PageBody>
    </div>
  );
}
