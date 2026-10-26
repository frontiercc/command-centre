// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import { Panel, Tag, Notice, Muted, B, cx } from '@/components/precision/ui';
import { Field } from '@/components/admin/precision-admin';
import { buildCodeClassifierSystemMessage, type CodeClassifierConfig } from '@/lib/pulse/code/classifier-prompt';

type TierKey = 'tier1' | 'tier2' | 'tier3';
const TIER_LABELS: Record<TierKey, string> = { tier1: 'Tier 1', tier2: 'Tier 2', tier3: 'Tier 3' };

export default function CodeClassifierTab() {
  const [config, setConfig] = useState<CodeClassifierConfig | null>(null);
  const [original, setOriginal] = useState<CodeClassifierConfig | null>(null);
  const [defaults, setDefaults] = useState<CodeClassifierConfig | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/pulse/code/classifier')
      .then(r => r.json())
      .then(d => { setConfig(d.config); setOriginal(d.config); setDefaults(d.defaults ?? null); })
      .finally(() => setLoading(false));
  }, []);

  const preview = config ? buildCodeClassifierSystemMessage(config) : '';

  if (loading || !config) {
    return <Panel><Muted>Loading classifier rubric…</Muted></Panel>;
  }

  const patchTier = (k: TierKey, field: 'name' | 'description', v: string) =>
    setConfig(c => c ? { ...c, tiers: { ...c.tiers, [k]: { ...c.tiers[k], [field]: v } } } : c);
  const patchWork = (i: number, field: 'name' | 'description', v: string) =>
    setConfig(c => { if (!c) return c; const w = [...c.workTypes]; w[i] = { ...w[i], [field]: v }; return { ...c, workTypes: w }; });
  const addWork = () => setConfig(c => c ? { ...c, workTypes: [...c.workTypes, { name: '', description: '' }] } : c);
  const removeWork = (i: number) => setConfig(c => { if (!c) return c; const w = [...c.workTypes]; w.splice(i, 1); return { ...c, workTypes: w }; });

  const save = async () => {
    setSaving(true); setSaveMsg(null);
    try {
      const res = await fetch('/api/pulse/code/classifier', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save-rubric', config }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't run the classifier. Try again.");
      setOriginal(config);
      setSaveMsg('Saved. Sessions classified from now on use this configuration');
      setTimeout(() => setSaveMsg(null), 5000);
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : 'Save failed');
    } finally { setSaving(false); }
  };

  const isDirty = JSON.stringify(config) !== JSON.stringify(original);

  return (
    <div className="flex flex-col gap-4">
      <Notice tone="info">
        <strong>Saving applies from now on.</strong> Sessions classified after you save use the new rubric; past classifications stay as they are. This is the only judged layer in Developer Pulse; the measured metrics (spend, autonomy, output) are unaffected.
      </Notice>

      {/* Tier rubric */}
      <Panel
        title="Tier rubric: delegation depth"
        subtitle="Tiers 1–3 describe how much the session was delegated to Claude. Descriptions are sent verbatim to the classifier."
        right={<Tag tone="judged">AI-judged</Tag>}
        flush
      >
        {(['tier1','tier2','tier3'] as TierKey[]).map((tk, i) => (
          <div key={tk} className={cx('px-4 py-3 flex flex-col gap-2', i > 0 && 'border-t border-[#F2F2F2]')}>
            <div className="flex items-center gap-3">
              <span className="text-[13px] font-medium text-[#666666] w-12 shrink-0">{TIER_LABELS[tk]}</span>
              <input type="text" value={config.tiers[tk].name} onChange={e => patchTier(tk, 'name', e.target.value)} placeholder="Tier name" aria-label={`${TIER_LABELS[tk]} name`} className={cx(B.input, 'flex-1 font-medium')} />
            </div>
            <textarea value={config.tiers[tk].description} onChange={e => patchTier(tk, 'description', e.target.value)} rows={3} aria-label={`${TIER_LABELS[tk]} description`} className={cx(B.input, 'w-full resize-none leading-5')} />
          </div>
        ))}
      </Panel>

      {/* Work types */}
      <Panel
        title="Work types"
        subtitle={<>Lowercase slugs the classifier outputs (e.g. <code className="font-mono text-[12px] bg-[#F2F2F2] px-1 rounded-[6px]">feature</code>). Renaming affects the Work Mix card&rsquo;s existing groupings.</>}
        flush
      >
        {config.workTypes.map((w, i) => (
          <div key={i} className={cx('flex items-center gap-2 px-4 py-2', i > 0 && 'border-t border-[#F2F2F2]')}>
            <input type="text" value={w.name} onChange={e => patchWork(i, 'name', e.target.value)} placeholder="work_type" aria-label="Work type" className={cx(B.input, 'w-44 font-mono text-[13px]')} />
            <input type="text" value={w.description} onChange={e => patchWork(i, 'description', e.target.value)} placeholder="Plain-English description" aria-label="Work type description" className={cx(B.input, 'flex-1 min-w-0 text-[13px]')} />
            <button type="button" onClick={() => removeWork(i)} className="text-[16px] leading-none px-2 text-[#8F8F8F] hover:text-[#B42318] shrink-0" title="Remove" aria-label="Remove work type">×</button>
          </div>
        ))}
        <div className={cx('px-4 py-2.5', config.workTypes.length > 0 && 'border-t border-[#F2F2F2]')}>
          <button type="button" onClick={addWork} className={B.link}>+ Add work type</button>
        </div>
      </Panel>

      {/* Signals + threshold */}
      <Panel title="Signals and threshold">
        <div className="flex flex-col gap-4">
          <Field label="Signals guidance">
            <textarea value={config.signalsGuidance} onChange={e => setConfig(c => c ? { ...c, signalsGuidance: e.target.value } : c)} rows={3} className={cx(B.input, 'w-full resize-y leading-5')} />
          </Field>
          <Field label="Confidence threshold">
            <input type="number" min="0" max="1" step="0.05" value={config.confidenceThreshold} onChange={e => { const n = parseFloat(e.target.value); setConfig(c => c ? { ...c, confidenceThreshold: Number.isNaN(n) ? c.confidenceThreshold : n } : c); }} className={cx(B.input, 'w-24 tabular-nums')} />
          </Field>
        </div>
      </Panel>

      {/* Actions */}
      <div className="flex items-center gap-3 flex-wrap">
        <button type="button" onClick={save} disabled={saving || !isDirty} className={B.primary}>{saving ? 'Saving…' : isDirty ? 'Save changes' : 'Saved'}</button>
        {config && <button type="button" onClick={() => setShowPreview(s => !s)} className={B.secondary}>{showPreview ? 'Hide prompt' : 'Preview prompt'}</button>}
        {defaults && <button type="button" onClick={() => setConfig(defaults)} className={B.secondary}>Reset to defaults</button>}
        {saveMsg && <span className={cx('text-[13px]', saveMsg.startsWith('Saved') ? 'text-[#1A7F37]' : 'text-[#B42318]')}>{saveMsg}</span>}
      </div>

      {showPreview && preview && (
        <Panel title="Classifier prompt preview" flush>
          <pre className="m-0 px-4 py-3 bg-[#FAFAFA] rounded-b-[8px] text-[13px] text-[#333333] whitespace-pre-wrap font-mono leading-relaxed overflow-auto max-h-96">{preview}</pre>
        </Panel>
      )}
    </div>
  );
}
