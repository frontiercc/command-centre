// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0
// Some icon drawings in this file are from Heroicons (MIT); see THIRD-PARTY-NOTICES.md.

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import TopBar from '@/components/layout/TopBar';
import { PageBody, Toolbar, Panel, Strip, Figure, Tag, B, Segmented, Notice, cx } from '@/components/precision/ui';

const FIELD_LABEL = 'block text-[13px] font-medium text-[#4D4D4D] mb-1';
const FIELD_HINT = 'ml-1 font-normal text-[#8F8F8F]';

interface InvocationStats {
  invocation_count: number;
  user_count: number;
  days_since_first: number;
  agent_chained_pct: number;
}

export default function LibrarySubmitPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const prefilledName = searchParams.get('name') ?? '';
  const prefilledType = (searchParams.get('type') as 'skill' | 'connector') ?? 'skill';
  const isClaim = !!prefilledName;

  const [name, setName]               = useState(prefilledName);
  const [type, setType]               = useState<'skill' | 'connector'>(prefilledType);
  const [description, setDescription] = useState('');
  const [installGuide, setInstallGuide] = useState('');
  const [sourceUrl, setSourceUrl]     = useState('');
  const [submitting, setSubmitting]   = useState(false);
  const [error, setError]             = useState('');
  const [stats, setStats]             = useState<InvocationStats | null>(null);

  // Fetch invocation stats for the pre-filled skill to show in the claim strip
  useEffect(() => {
    if (!prefilledName) return;
    const now = Math.floor(Date.now() / 1000);
    fetch(`/api/library?q=${encodeURIComponent(prefilledName)}&claimed=false`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => {
        const entry = data.entries?.find((e: { name: string; invocation_count: number; user_count: number; created_at: number; stats?: { agent_chained_pct: number } }) => e.name === prefilledName);
        if (entry) {
          setStats({
            invocation_count:   entry.invocation_count,
            user_count:         entry.user_count,
            days_since_first:   Math.floor((now - (entry.created_at ?? now)) / 86400),
            agent_chained_pct:  entry.stats?.agent_chained_pct ?? 0,
          });
        }
      })
      .catch(() => {});
  }, [prefilledName]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError('Skill name is required.'); return; }
    setSubmitting(true);
    setError('');

    try {
      const res = await fetch('/api/library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), type, description, install_guide: installGuide, source_url: sourceUrl }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? 'Something went wrong. Please try again.');
        return;
      }
      const entry = await res.json();
      router.push(`/library/${entry.id}`);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <TopBar
        title={isClaim ? `Claim this ${prefilledType}` : 'Submit a skill or connector'}
        subtitle="Add your entry to the org library so teammates can discover it"
      />
      <PageBody>
        <Toolbar left={
          <Link href="/library" className="inline-flex items-center gap-1 text-[#245BF3] hover:underline">
            <svg aria-hidden="true" width={14} height={14} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
            </svg>
            Back to the S&amp;C Board
          </Link>
        } />

        <div className="max-w-[760px] w-full flex flex-col gap-4">
          {/* Invocation stats (claim mode only) */}
          {isClaim && stats && (
            <Strip cols={4}>
              <Figure label="Invocations" value={stats.invocation_count.toLocaleString()} />
              <Figure label="Teammates using it" value={stats.user_count.toLocaleString()} />
              <Figure label="Days since first use" value={stats.days_since_first.toLocaleString()} />
              <Figure label="Agent-chained" value={`${stats.agent_chained_pct}%`} />
            </Strip>
          )}

          <Panel
            title={
              <span className="inline-flex items-center gap-2">
                <svg aria-hidden="true" width={16} height={16} className="shrink-0 text-[#8F8F8F]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                </svg>
                {isClaim ? <span className="font-mono">{prefilledName}</span> : 'New entry'}
              </span>
            }
            badge={isClaim ? <Tag tone="warn">Org-built</Tag> : undefined}
            subtitle={isClaim
              ? `You were the first to use ${prefilledName}. Add a description so teammates know what it does.`
              : 'Add a skill or connector to the library so teammates can discover and use it.'}
            flush
          >
            <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-4">
              {/* Name */}
              {!isClaim && (
                <div>
                  <label htmlFor="lib-submit-name" className={FIELD_LABEL}>Skill name</label>
                  <input
                    id="lib-submit-name"
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="e.g. deep-research or anthropic-skills:docx"
                    className={cx(B.input, 'w-full font-mono')}
                    required
                  />
                </div>
              )}

              {/* Type */}
              {!isClaim && (
                <div>
                  <span className={FIELD_LABEL}>Type</span>
                  <Segmented
                    label="Type"
                    options={[{ value: 'skill' as const, label: 'Skill' }, { value: 'connector' as const, label: 'Connector' }]}
                    value={type}
                    onChange={setType}
                  />
                </div>
              )}

              {/* Description */}
              <div>
                <label htmlFor="lib-submit-desc" className={FIELD_LABEL}>
                  Description
                  <span className={FIELD_HINT}>(what does it do, when should teammates use it?)</span>
                </label>
                <textarea
                  id="lib-submit-desc"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  rows={3}
                  placeholder="e.g. Validates a dataset against a schema, flags type mismatches and null anomalies, useful before any pipeline handoff…"
                  className={cx(B.input, 'w-full resize-none')}
                />
              </div>

              {/* Install guide */}
              <div>
                <label htmlFor="lib-submit-guide" className={FIELD_LABEL}>
                  Install guide
                  <span className={FIELD_HINT}>(optional: steps to set this up, or a command to run)</span>
                </label>
                <textarea
                  id="lib-submit-guide"
                  value={installGuide}
                  onChange={e => setInstallGuide(e.target.value)}
                  rows={4}
                  placeholder={'e.g.\n1. Copy this file to ~/.claude/commands/\n2. Restart Claude Code\n3. Run /deep-research'}
                  className={cx(B.input, 'w-full resize-none font-mono')}
                />
              </div>

              {/* Source URL */}
              <div>
                <label htmlFor="lib-submit-url" className={FIELD_LABEL}>
                  Source link
                  <span className={FIELD_HINT}>(optional: GitHub, Notion, internal wiki)</span>
                </label>
                <input
                  id="lib-submit-url"
                  type="url"
                  value={sourceUrl}
                  onChange={e => setSourceUrl(e.target.value)}
                  placeholder="https://…"
                  className={cx(B.input, 'w-full')}
                />
              </div>

              {error && <Notice tone="error">{error}</Notice>}

              <div className="flex items-center gap-3 flex-wrap pt-3 border-t border-[#F2F2F2]">
                <p className="m-0 text-[13px] text-[#8F8F8F]">
                  {isClaim ? "You'll be listed as the author." : "You'll be listed as the author of this entry."}
                </p>
                <div className="ml-auto flex gap-2">
                  {isClaim && (
                    <Link href="/library" className={B.secondary}>
                      Not mine
                    </Link>
                  )}
                  <button type="submit" disabled={submitting} className={B.primary}>
                    {submitting ? 'Publishing…' : 'Publish to library'}
                  </button>
                </div>
              </div>
            </form>
          </Panel>
        </div>
      </PageBody>
    </>
  );
}
