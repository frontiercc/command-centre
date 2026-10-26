// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import { type TierConfig, type TaskTypeDef } from '@/lib/pulse/tier-config';
import { Panel, Muted, Notice, Tag, B, cx } from '@/components/precision/ui';
import { Field, SaveMsg } from '@/components/admin/precision-admin';

type TierKey = 'tier1' | 'tier2' | 'tier3';

const TIER_LABELS: Record<TierKey, string> = {
  tier1: 'Tier 1',
  tier2: 'Tier 2',
  tier3: 'Tier 3',
};

export default function TierConfigTab() {
  const [config, setConfig] = useState<TierConfig | null>(null);
  const [original, setOriginal] = useState<TierConfig | null>(null);
  const [defaults, setDefaults] = useState<TierConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    fetch('/api/pulse/admin/tiers')
      .then(r => r.json())
      .then(d => {
        setConfig(d.config);
        setOriginal(d.config);
        setDefaults(d.defaults ?? null);
        setPreview(d.promptPreview);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading || !config) {
    return <Panel><Muted>Loading tier configuration…</Muted></Panel>;
  }

  const patchTier = (k: TierKey, field: 'name' | 'description', value: string) => {
    setConfig(c => c ? { ...c, tiers: { ...c.tiers, [k]: { ...c.tiers[k], [field]: value } } } : c);
  };

  const patchTaskType = (tier: TierKey, idx: number, field: keyof TaskTypeDef, value: string) => {
    setConfig(c => {
      if (!c) return c;
      const updated = [...c.taxonomy[tier]];
      updated[idx] = { ...updated[idx], [field]: value };
      return { ...c, taxonomy: { ...c.taxonomy, [tier]: updated } };
    });
  };

  const addTaskType = (tier: TierKey) => {
    setConfig(c => c ? {
      ...c,
      taxonomy: { ...c.taxonomy, [tier]: [...c.taxonomy[tier], { name: '', description: '' }] },
    } : c);
  };

  const removeTaskType = (tier: TierKey, idx: number) => {
    setConfig(c => {
      if (!c) return c;
      const updated = [...c.taxonomy[tier]];
      updated.splice(idx, 1);
      return { ...c, taxonomy: { ...c.taxonomy, [tier]: updated } };
    });
  };

  const loadPreview = async () => {
    setPreviewLoading(true);
    try {
      const res = await fetch('/api/pulse/admin/tiers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
      });
      const data = await res.json();
      setPreview(data.promptPreview);
      setShowPreview(true);
    } finally {
      setPreviewLoading(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch('/api/pulse/admin/tiers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(typeof err.error === 'string' ? err.error : "Couldn't save. Try again.");
      }
      const data = await res.json();
      setPreview(data.promptPreview);
      setOriginal(config);
      setSaveMsg('Saved: the next classifier batch will use this configuration');
      setTimeout(() => setSaveMsg(null), 4000);
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const isDirty = JSON.stringify(config) !== JSON.stringify(original);

  return (
    <div className="flex flex-col gap-4">

      {/* Info banner */}
      <Notice tone="info" title="Saving applies from now on.">
        Prompts classified after you save use the new rubric; past classifications stay as they are. 
Changes take effect on the next classifier run (every 5 minutes). Use &ldquo;Preview prompt&rdquo; to inspect exactly what the AI will receive before saving.
      </Notice>

      {/* Structural constraints notice */}
      <Notice tone="info" title="Structural constraints: load-bearing metric logic.">
        <strong>Tier 2</strong> requires: connector (MCP tool) use <em>or</em> specialised skill invocation <em>or</em> multi-step synthesis.
        {' '}<strong>Tier 3</strong> requires: connector orchestration across systems <em>or</em> skill invocation <em>plus</em> genuine reasoning complexity.
        {' '}These are objective qualifying signals baked into the rubric. Editing tier descriptions changes the AI&rsquo;s language context; it does not remove these structural requirements, which are enforced by the classifier prompt architecture.
      </Notice>

      {/* Tier Rubric */}
      <Panel title="Tier rubric" flush>
        {(['tier1', 'tier2', 'tier3'] as TierKey[]).map(tk => (
          <div key={tk} className="px-4 py-3 border-t border-[#F2F2F2] first:border-t-0 flex flex-col gap-2">
            <div className="flex items-center gap-3">
              <span className="w-14 shrink-0"><Tag tone="judged">{TIER_LABELS[tk]}</Tag></span>
              <input
                type="text"
                value={config.tiers[tk].name}
                onChange={e => patchTier(tk, 'name', e.target.value)}
                placeholder="Tier name (e.g. Administrative)"
                aria-label={`${TIER_LABELS[tk]} name`}
                className={cx(B.input, 'flex-1 min-w-0 font-medium')}
              />
            </div>
            <textarea
              value={config.tiers[tk].description}
              onChange={e => patchTier(tk, 'description', e.target.value)}
              rows={3}
              placeholder="Full description of this tier (sent verbatim to the classifier)"
              aria-label={`${TIER_LABELS[tk]} description`}
              className={cx(B.input, 'w-full resize-none leading-5')}
            />
          </div>
        ))}
      </Panel>

      {/* Task Taxonomy */}
      <Panel title="Task type taxonomy" flush>
        <p className="m-0 px-4 py-3 text-[13px] text-[#666666] leading-5">
          Task type names must be lowercase with underscores (e.g. <code className="font-mono text-[12px]">research_brief</code>).
          These are the slugs the classifier outputs; changing them affects existing queries that filter by task type.
        </p>
        {(['tier1', 'tier2', 'tier3'] as TierKey[]).map(tk => (
          <div key={tk} className="px-4 py-3 border-t border-[#F2F2F2]">
            <div className="flex items-center gap-2 mb-2">
              <Tag tone="judged">{TIER_LABELS[tk]}</Tag>
              <span className="text-[13px] text-[#8F8F8F]">{config.tiers[tk].name}</span>
            </div>
            <div className="flex flex-col gap-2">
              {config.taxonomy[tk].map((tt, idx) => (
                <div key={idx} className="flex items-start gap-2">
                  <input
                    type="text"
                    value={tt.name}
                    onChange={e => patchTaskType(tk, idx, 'name', e.target.value)}
                    placeholder="task_type_slug"
                    aria-label="Task type slug"
                    className={cx(B.input, 'w-32 sm:w-44 font-mono text-[13px]')}
                  />
                  <input
                    type="text"
                    value={tt.description}
                    onChange={e => patchTaskType(tk, idx, 'description', e.target.value)}
                    placeholder="Plain-English description"
                    aria-label="Task type description"
                    className={cx(B.input, 'flex-1 min-w-0 text-[13px]')}
                  />
                  <button
                    type="button"
                    onClick={() => removeTaskType(tk, idx)}
                    className={B.danger}
                    title="Remove"
                    aria-label={`Remove task type ${tt.name || idx + 1}`}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => addTaskType(tk)}
                className={cx(B.link, 'self-start mt-1')}
              >
                + Add task type
              </button>
            </div>
          </div>
        ))}
      </Panel>

      {/* Special criteria */}
      <Panel title="Detection criteria">
        <div className="flex flex-col gap-4">
          <Field label="Frontier push criteria">
            <textarea
              value={config.frontierPushCriteria}
              onChange={e => setConfig(c => c ? { ...c, frontierPushCriteria: e.target.value } : c)}
              rows={4}
              className={cx(B.input, 'w-full resize-y leading-5')}
            />
          </Field>

          <Field label="Capability creation criteria">
            <textarea
              value={config.capabilityCreationCriteria}
              onChange={e => setConfig(c => c ? { ...c, capabilityCreationCriteria: e.target.value } : c)}
              rows={6}
              className={cx(B.input, 'w-full resize-y leading-5')}
            />
          </Field>

          <Field
            label="Confidence threshold"
            hint="Classifications below this confidence are flagged in the health view. Default: 0.7"
          >
            <input
              type="number"
              min="0" max="1" step="0.05"
              value={config.confidenceThreshold}
              onChange={e => setConfig(c => c ? { ...c, confidenceThreshold: parseFloat(e.target.value) || 0.7 } : c)}
              className={cx(B.input, 'w-24 tabular-nums')}
            />
          </Field>
        </div>
      </Panel>

      {/* Action bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={save}
          disabled={saving || !isDirty}
          className={B.primary}
        >
          {saving ? 'Saving…' : isDirty ? 'Save changes' : 'Saved'}
        </button>
        <button
          type="button"
          onClick={loadPreview}
          disabled={previewLoading}
          className={B.secondary}
        >
          {previewLoading ? 'Loading…' : 'Preview prompt'}
        </button>
        {defaults && (
          <button
            type="button"
            onClick={() => setConfig(defaults)}
            className={B.secondary}
          >
            Reset to defaults
          </button>
        )}
        <SaveMsg msg={saveMsg} ok={saveMsg ? saveMsg.startsWith('Saved') : undefined} />
      </div>

      {/* Prompt preview */}
      {showPreview && preview && (
        <Panel
          title="Classifier system prompt preview"
          right={
            <button
              type="button"
              onClick={() => setShowPreview(false)}
              className={B.secondary}
            >
              Close
            </button>
          }
        >
          <pre className="m-0 text-[13px] text-[#333333] bg-[#FAFAFA] border border-[#EAEAEA] rounded-[10px] p-3 whitespace-pre-wrap font-mono leading-relaxed overflow-auto max-h-96">
            {preview}
          </pre>
        </Panel>
      )}
    </div>
  );
}
