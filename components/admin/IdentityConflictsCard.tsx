// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

// Identity conflicts: two Claude accounts sending from one installation, or
// one ChatGPT and Codex account arriving under two emails. The second email is
// kept as its own person until an admin decides. Merge and Undo take effect
// going forward only.

import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/components/shared/ToastProvider';
import { Panel, Muted, B, cx } from '@/components/precision/ui';

interface Conflict {
  id: string;
  installationShort: string;
  product?: 'claude' | 'openai';
  surface: string;
  existingEmail: string | null;
  existingName: string | null;
  newEmail: string;
  firstSeenAt: number;
  lastSeenAt: number;
  eventCount: number;
  status: 'open' | 'merged' | 'separate';
  decidedBy: string | null;
  decidedAt: number | null;
}

const fmt = (s: number | null) => (s ? new Date(s * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const surfaceLabel = (s: string) => (
  s === 'code' ? 'Claude Code' : s === 'cowork' ? 'Cowork' : s === 'chatgpt' ? 'ChatGPT' : s === 'codex' ? 'Codex' : s
);
const productLabel = (p: Conflict['product']) => (p === 'openai' ? 'ChatGPT and Codex' : 'Claude');
const sourceWords = (c: Conflict) => (c.product === 'openai'
  ? { verb: ' is arriving from an OpenAI account used by ', id: 'OpenAI account' }
  : { verb: ' is sending from an installation used by ', id: 'installation' });

export default function IdentityConflictsCard() {
  const { showToast } = useToast();
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch('/api/admin/identity-conflicts')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { conflicts: Conflict[] }) => setConflicts(d.conflicts))
      .catch(() => setConflicts([]));
  }, []);

  useEffect(() => { load(); }, [load]);

  const act = async (id: string, action: 'merge' | 'separate' | 'undo') => {
    setBusy(id);
    try {
      const r = await fetch(`/api/admin/identity-conflicts/${encodeURIComponent(id)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Failed');
      showToast(action === 'merge' ? 'Merged. New events go to the existing person' : action === 'separate' ? 'Kept as separate people' : 'Decision undone', 'success');
      load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed', 'error');
    } finally {
      setBusy(null);
    }
  };

  if (conflicts === null) return null;
  const open = conflicts.filter(c => c.status === 'open');
  const decided = conflicts.filter(c => c.status !== 'open');

  return (
    <Panel title="Identity conflicts" flush>
      <p className="m-0 px-4 pt-3 pb-3 text-[13px] text-[#666666] leading-5">
        Two people arriving as one: two Claude accounts sending from the same installation, or one ChatGPT and Codex account arriving under two email addresses. The second email is kept as its own person until you decide.
        <strong className="font-medium text-[#0A0A0A]"> Merge</strong> sends that email&apos;s future events to the existing person;
        <strong className="font-medium text-[#0A0A0A]"> Keep separate</strong> leaves them as two people. Either can be undone. Neither moves past events, and neither changes anyone&apos;s login.
      </p>

      {open.length === 0 ? (
        <div className="px-4 py-3 border-t border-[#F2F2F2]">
          <Muted>No identity conflicts.</Muted>
        </div>
      ) : (
        <ul className="m-0 p-0 list-none">
          <li className="hidden sm:flex px-4 py-2 border-t border-[#F2F2F2] gap-4 text-[12px] font-medium text-[#8F8F8F]">
            <span className="w-36 shrink-0">Product</span>
            <span>Accounts</span>
          </li>
          {open.map(c => (
            <li key={c.id} className="px-4 py-3 border-t border-[#F2F2F2] flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col gap-1 sm:flex-row sm:gap-4 min-w-0">
                <span className="w-36 shrink-0 text-[13px] text-[#333333]">{productLabel(c.product)}</span>
                <div className="text-[14px] min-w-0">
                  <div className="text-[#0A0A0A] break-words">
                    <span className="font-mono text-[13px]">{c.newEmail}</span>
                    <span className="text-[#666666]">{sourceWords(c).verb}</span>
                    <span className="font-mono text-[13px]">{c.existingEmail ?? 'another user'}</span>
                    {c.existingName ? <span className="text-[#666666]"> ({c.existingName})</span> : null}
                  </div>
                  <div className="text-[13px] text-[#8F8F8F] mt-0.5 tabular-nums">
                    {surfaceLabel(c.surface)} · {sourceWords(c).id} {c.installationShort}… · first seen {fmt(c.firstSeenAt)} · last seen {fmt(c.lastSeenAt)} · {c.eventCount.toLocaleString('en-GB')} events
                  </div>
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button type="button" disabled={busy === c.id} onClick={() => act(c.id, 'separate')} className={B.secondary}>Keep separate</button>
                <button type="button" disabled={busy === c.id} onClick={() => act(c.id, 'merge')} className={B.primary}>Merge</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {decided.length > 0 && (
        <details className="px-4 py-3 border-t border-[#EAEAEA]">
          <summary className="text-[13px] font-medium text-[#666666] cursor-pointer">Decided ({decided.length})</summary>
          <ul className="m-0 p-0 list-none mt-2">
            {decided.map(c => (
              <li key={c.id} className="py-2 border-t border-[#F2F2F2] first:border-t-0 flex items-center justify-between gap-3 text-[14px]">
                <span className="text-[#333333] min-w-0 break-words">
                  <span className="text-[13px] text-[#8F8F8F]">{productLabel(c.product)} · </span>
                  <span className="font-mono text-[13px]">{c.newEmail}</span>
                  {c.status === 'merged' ? ' merged into ' : ' kept separate from '}
                  <span className="font-mono text-[13px]">{c.existingEmail ?? 'another user'}</span>
                  <span className="text-[#8F8F8F]"> · {c.decidedBy ?? '—'}, {fmt(c.decidedAt)}</span>
                </span>
                <button type="button" disabled={busy === c.id} onClick={() => act(c.id, 'undo')} className={cx(B.link, 'shrink-0')}>Undo</button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Panel>
  );
}
