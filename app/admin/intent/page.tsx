// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { useToast } from '@/components/shared/ToastProvider';
import { PageBody, Panel, Muted, Dot, SEVERITY_COLOR, B, cx } from '@/components/precision/ui';

interface IntentCategory {
  id: string;
  name: string;
  description: string;
  phrases: string[];
  defaultSeverity: 'low' | 'medium' | 'high' | 'critical';
  builtIn: boolean;
  enabled: boolean;
}


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

const EMPTY_CATEGORY: IntentCategory = {
  id: '',
  name: '',
  description: '',
  phrases: [],
  defaultSeverity: 'medium',
  builtIn: false,
  enabled: true,
};

export default function AdminIntentPage() {
  const [builtIn, setBuiltIn] = useState<IntentCategory[]>([]);
  const [custom, setCustom] = useState<IntentCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<IntentCategory>(EMPTY_CATEGORY);
  const [phrasesText, setPhrasesText] = useState('');
  const { showToast } = useToast();

  useEffect(() => {
    fetch('/api/intent-categories')
      .then(r => r.json())
      .then(data => {
        setBuiltIn(data.builtIn || []);
        setCustom(data.custom || []);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const toggleBuiltIn = (id: string) => {
    setBuiltIn(prev => prev.map(c =>
      c.id === id ? { ...c, enabled: !c.enabled } : c
    ));
  };

  const startAdd = () => {
    const newId = `custom_${Date.now()}`;
    setEditingId('__new__');
    setEditForm({ ...EMPTY_CATEGORY, id: newId });
    setPhrasesText('');
  };

  const startEdit = (cat: IntentCategory) => {
    setEditingId(cat.id);
    setEditForm({ ...cat });
    setPhrasesText(cat.phrases.join('\n'));
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditForm(EMPTY_CATEGORY);
    setPhrasesText('');
  };

  const saveEdit = () => {
    const phrases = phrasesText.split('\n').map(p => p.trim()).filter(Boolean);
    if (!editForm.name.trim()) {
      showToast('Category name is required', 'error');
      return;
    }
    if (phrases.length === 0) {
      showToast('At least one phrase is required', 'error');
      return;
    }

    const updated = { ...editForm, phrases };

    if (editingId === '__new__') {
      setCustom(prev => [...prev, updated]);
    } else {
      setCustom(prev => prev.map(c => c.id === editingId ? updated : c));
    }
    cancelEdit();
  };

  const deleteCategory = (id: string) => {
    setCustom(prev => prev.filter(c => c.id !== id));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const builtInToggles: Record<string, boolean> = {};
      for (const cat of builtIn) {
        builtInToggles[cat.id] = cat.enabled;
      }

      const res = await fetch('/api/intent-categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ builtInToggles, custom }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Save failed');
      }
      showToast('Intent detection settings saved', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1">
        <TopBar title="Intent Detection" />
        <div className="flex items-center justify-center py-20">
          <LoadingSpinner />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1">
      <TopBar title="Intent Detection" />
      <PageBody className="max-w-[1000px]">

        {/* Section 1: Built-in Categories */}
        <Panel
          title="Built-in categories"
          subtitle="12 default intent detection categories. These cannot be deleted but can be toggled on or off."
          flush
        >
          {builtIn.map(cat => (
            <div key={cat.id} className="flex items-start gap-4 px-4 py-3 border-t border-[#F2F2F2] first:border-t-0">
              <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <span className="text-[14px] font-medium text-[#0A0A0A]">{cat.name}</span>
                  <SeverityDot severity={cat.defaultSeverity} />
                </div>
                <span className="text-[13px] text-[#666666] leading-5">{cat.description}</span>
                <span className="text-[13px] text-[#8F8F8F] tabular-nums">{cat.phrases.length} phrases</span>
              </div>
              <Switch checked={cat.enabled} onChange={() => toggleBuiltIn(cat.id)} label={cat.name} />
            </div>
          ))}
        </Panel>

        {/* Section 2: Custom Categories */}
        <Panel
          title="Custom categories"
          subtitle="Define organisation-specific intent categories with plain-text phrases."
          right={editingId === null ? (
            <button type="button" onClick={startAdd} className={B.secondary}>
              Add category
            </button>
          ) : undefined}
          flush
        >
          {custom.length === 0 && editingId === null && (
            <div className="p-4"><Muted>No custom categories defined. Click &quot;Add category&quot; to create one.</Muted></div>
          )}

          {custom.map(cat => (
            editingId === cat.id ? (
              <div key={cat.id} className="px-4 py-3 border-t border-[#F2F2F2] first:border-t-0">
                <CategoryForm
                  form={editForm}
                  phrasesText={phrasesText}
                  onFormChange={setEditForm}
                  onPhrasesChange={setPhrasesText}
                  onSave={saveEdit}
                  onCancel={cancelEdit}
                />
              </div>
            ) : (
              <div key={cat.id} className="flex items-start gap-4 px-4 py-3 border-t border-[#F2F2F2] first:border-t-0">
                <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <span className="text-[14px] font-medium text-[#0A0A0A]">{cat.name}</span>
                    <SeverityDot severity={cat.defaultSeverity} />
                  </div>
                  <span className="text-[13px] text-[#666666] leading-5">{cat.description}</span>
                  <span className="text-[13px] text-[#8F8F8F]">{cat.phrases.length} phrases: {cat.phrases.slice(0, 3).join(', ')}{cat.phrases.length > 3 ? '...' : ''}</span>
                </div>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => startEdit(cat)} className={cx(B.link, 'px-2 py-1')}>
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteCategory(cat.id)}
                    className="text-[13px] font-medium px-2 py-1 rounded-[10px] text-[#B42318] hover:bg-[#FFF5F4]"
                  >
                    Delete
                  </button>
                </div>
                <Switch
                  checked={cat.enabled}
                  onChange={() => setCustom(prev => prev.map(c => c.id === cat.id ? { ...c, enabled: !c.enabled } : c))}
                  label={cat.name}
                />
              </div>
            )
          ))}

          {editingId === '__new__' && (
            <div className="px-4 py-3 border-t border-[#F2F2F2] first:border-t-0">
              <CategoryForm
                form={editForm}
                phrasesText={phrasesText}
                onFormChange={setEditForm}
                onPhrasesChange={setPhrasesText}
                onSave={saveEdit}
                onCancel={cancelEdit}
              />
            </div>
          )}
        </Panel>

        {/* Save Button */}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className={B.primary}
          >
            {saving ? 'Saving...' : 'Save intent settings'}
          </button>
        </div>
      </PageBody>
    </div>
  );
}

function SeverityDot({ severity }: { severity: IntentCategory['defaultSeverity'] }) {
  return (
    <Dot color={SEVERITY_COLOR[severity] ?? SEVERITY_COLOR.low}>
      <span className="capitalize text-[#666666]">{severity}</span>
    </Dot>
  );
}

function CategoryForm({
  form,
  phrasesText,
  onFormChange,
  onPhrasesChange,
  onSave,
  onCancel,
}: {
  form: IntentCategory;
  phrasesText: string;
  onFormChange: (f: IntentCategory) => void;
  onPhrasesChange: (t: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const labelCls = 'flex flex-col gap-1.5 text-[14px] font-medium text-[#0A0A0A] min-w-0';
  return (
    <div className="border border-[#EAEAEA] bg-[#FAFAFA] rounded-[10px] p-4 flex flex-col gap-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className={labelCls}>
          Name
          <input
            type="text"
            value={form.name}
            onChange={e => onFormChange({ ...form, name: e.target.value, id: form.id || `custom_${e.target.value.toLowerCase().replace(/\s+/g, '_')}` })}
            placeholder="e.g. PHI Request"
            className={cx(B.input, 'w-full font-normal')}
          />
        </label>
        <label className={labelCls}>
          Default severity
          <select
            value={form.defaultSeverity}
            onChange={e => onFormChange({ ...form, defaultSeverity: e.target.value as IntentCategory['defaultSeverity'] })}
            className={cx(B.select, 'w-full text-[14px] font-normal')}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </label>
      </div>
      <label className={labelCls}>
        Description
        <input
          type="text"
          value={form.description}
          onChange={e => onFormChange({ ...form, description: e.target.value })}
          placeholder="e.g. Protected health information requests"
          className={cx(B.input, 'w-full font-normal')}
        />
      </label>
      <label className={labelCls}>
        Phrases (one per line)
        <textarea
          value={phrasesText}
          onChange={e => onPhrasesChange(e.target.value)}
          rows={4}
          placeholder={"patient records\nmedical history\nprescription data"}
          className={cx(B.input, 'w-full resize-none font-mono font-normal')}
        />
        <span className="text-[13px] font-normal text-[#8F8F8F]">
          Plain-text phrases matched case-insensitively. One phrase per line.
        </span>
      </label>
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className={B.secondary}>
          Cancel
        </button>
        <button type="button" onClick={onSave} className={B.primary}>
          Save category
        </button>
      </div>
    </div>
  );
}
