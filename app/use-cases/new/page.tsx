// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { PageBody, Toolbar, Panel, B, Notice, cx } from '@/components/precision/ui';

const SURFACES = [
  { value: 'cowork', label: 'Cowork' },
  { value: 'code', label: 'Code' },
  { value: 'chat', label: 'Chat' },
];

function toList(input: string): string[] {
  return input
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

const inputCls = cx(B.input, 'w-full');
const labelCls = 'block text-[13px] font-medium text-[#4D4D4D] mb-1';
const hintCls = 'm-0 mt-1 text-[13px] text-[#8F8F8F]';

export default function NewUseCasePage() {
  const router = useRouter();
  const [checked, setChecked] = useState(false);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [departments, setDepartments] = useState('');
  const [surfaces, setSurfaces] = useState<string[]>([]);
  const [keywords, setKeywords] = useState('');
  const [skills, setSkills] = useState('');
  const [connectors, setConnectors] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/session')
      .then(r => r.json())
      .then(data => {
        if (!data.authenticated) { router.replace('/'); return; }
        const role = data.user?.role ?? '';
        if (role !== 'admin' && role !== 'manager') { router.replace('/'); return; }
        setChecked(true);
      })
      .catch(() => router.replace('/'));
  }, [router]);

  const toggleSurface = (value: string) => {
    setSurfaces(prev => (prev.includes(value) ? prev.filter(s => s !== value) : [...prev, value]));
  };

  const handleSubmit = async () => {
    setError(null);
    if (!title.trim()) {
      setError('Title is required');
      return;
    }
    if (!description.trim()) {
      setError('Describe the work: it is what sessions are judged against');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/use-cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || null,
          departments: toList(departments),
          surfaces,
          keywords: toList(keywords),
          skills: toList(skills),
          connectors: toList(connectors),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Failed to save use case');
      router.push(`/use-cases/${encodeURIComponent(data.id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save use case');
      setSaving(false);
    }
  };

  if (!checked) {
    return (
      <>
        <TopBar title="Add Use Case" subtitle="Guided intake" />
        <LoadingSpinner />
      </>
    );
  }

  return (
    <>
      <TopBar title="Add Use Case" subtitle="Guided intake" />
      <PageBody>
        <Toolbar left={<Link href="/use-cases" className="text-[#245BF3] hover:underline">Back to Use Cases</Link>} />
        <div className="max-w-[760px] w-full">
          <Panel title="Use case" flush>
            <div className="p-4 flex flex-col gap-4">
              <div>
                <label htmlFor="uc-new-title" className={labelCls}>Title <span aria-hidden="true">*</span></label>
                <input
                  id="uc-new-title"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder="e.g. Contract review acceleration"
                  className={inputCls}
                  aria-required="true"
                />
              </div>

              <div>
                <label htmlFor="uc-new-desc" className={labelCls}>Description <span aria-hidden="true">*</span></label>
                <textarea
                  id="uc-new-desc"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="What the work is and what it produces, e.g. Finance drafts the board variance commentary from the management accounts each month end."
                  rows={3}
                  className={inputCls}
                  aria-required="true"
                />
                <p className={hintCls}>Claude reads each finished session and judges whether it is this work, from this description. Say what the work is about and what it produces.</p>
              </div>

              <div>
                <label htmlFor="uc-new-depts" className={labelCls}>Department(s)</label>
                <input
                  id="uc-new-depts"
                  value={departments}
                  onChange={e => setDepartments(e.target.value)}
                  placeholder="Legal, Finance"
                  className={inputCls}
                />
                <p className={hintCls}>Comma-separated. Leave blank if org-wide.</p>
              </div>

              <fieldset className="m-0 p-0 border-0">
                <legend className={labelCls}>Surface(s)</legend>
                <div className="flex items-center gap-4">
                  {SURFACES.map(s => (
                    <label key={s.value} className="flex items-center gap-1.5 text-[14px] text-[#333333] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={surfaces.includes(s.value)}
                        onChange={() => toggleSurface(s.value)}
                        className="accent-[#0A0A0A]"
                      />
                      {s.label}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>

            <div className="px-4 py-4 border-t border-[#F2F2F2] flex flex-col gap-4">
              <div>
                <p className="m-0 text-[14px] font-semibold text-[#0A0A0A]">Clues (optional)</p>
                <p className="m-0 mt-0.5 text-[13px] text-[#8F8F8F]">
                  Phrases people use for this work, and the skills or connectors it involves. They help recognise it; on their own they never count.
                </p>
              </div>

              <div>
                <label htmlFor="uc-new-keywords" className={labelCls}>Phrases people use for this work</label>
                <input
                  id="uc-new-keywords"
                  value={keywords}
                  onChange={e => setKeywords(e.target.value)}
                  placeholder="contract, NDA, redline"
                  className={inputCls}
                />
                <p className={hintCls}>Comma-separated. Hints for the judge, never a match on their own.</p>
              </div>

              <div>
                <label htmlFor="uc-new-skills" className={labelCls}>Skills</label>
                <input
                  id="uc-new-skills"
                  value={skills}
                  onChange={e => setSkills(e.target.value)}
                  placeholder="contract-review, redline-assistant"
                  className={inputCls}
                />
                <p className={hintCls}>Comma-separated skill names.</p>
              </div>

              <div>
                <label htmlFor="uc-new-connectors" className={labelCls}>Connectors</label>
                <input
                  id="uc-new-connectors"
                  value={connectors}
                  onChange={e => setConnectors(e.target.value)}
                  placeholder="docusign, salesforce"
                  className={inputCls}
                />
                <p className={hintCls}>Comma-separated MCP connector/server names.</p>
              </div>
            </div>

            <div className="px-4 py-3 border-t border-[#F2F2F2] flex flex-col gap-3">
              {error && <Notice tone="error">{error}</Notice>}
              <div className="flex items-center gap-2">
                <button type="button" onClick={handleSubmit} disabled={saving} className={B.primary}>
                  {saving ? 'Saving...' : 'Create use case'}
                </button>
                <button type="button" onClick={() => router.push('/use-cases')} className={B.secondary}>
                  Cancel
                </button>
              </div>
            </div>
          </Panel>
        </div>
      </PageBody>
    </>
  );
}
