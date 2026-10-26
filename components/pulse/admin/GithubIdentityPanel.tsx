// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import { Panel, Notice, Muted, SubHead, B, cx } from '@/components/precision/ui';

interface Mapping { identity: string; user_id: string; display_name: string }
interface Unmatched { identity: string; commit_count: number }
interface UserOpt { id: string; display_name: string | null; email: string }

export default function GithubIdentityPanel({ onToast }: { onToast: (msg: string, kind: 'success' | 'error') => void }) {
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [unmatched, setUnmatched] = useState<Unmatched[]>([]);
  const [users, setUsers] = useState<UserOpt[]>([]);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = () => {
    fetch('/api/pulse/code/github/identity')
      .then(r => r.json())
      .then(d => { setMappings(d.mappings ?? []); setUnmatched(d.unmatched ?? []); setLoadFailed(false); })
      .catch(() => { setLoadFailed(true); });
  };
  useEffect(() => {
    load();
    fetch('/api/users?all=true').then(r => r.json()).then(d => setUsers(Array.isArray(d) ? d : (d.users ?? []))).catch(() => {});
  }, []);

  const mapIdentity = async (identity: string) => {
    const userId = pick[identity];
    if (!userId) return;
    setBusy(true);
    try {
      const res = await fetch('/api/pulse/code/github/identity', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity, userId }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Mapping failed');
      onToast('Mapped. Takes effect on the next sync (use Sync now to fast-track)', 'success');
      load();
    } catch (err) { onToast(err instanceof Error ? err.message : 'Mapping failed', 'error'); }
    finally { setBusy(false); }
  };

  const removeMapping = async (identity: string) => {
    setBusy(true);
    try {
      const res = await fetch('/api/pulse/code/github/identity', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Remove failed');
      onToast('Mapping removed. Reverts on the next sync', 'success');
      load();
    } catch (err) { onToast(err instanceof Error ? err.message : 'Remove failed', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <Panel title="Commit author mapping" flush>
      <p className="m-0 px-4 py-3 text-[13px] text-[#666666] leading-5">
        GitHub commit authors are matched to people by email automatically; map the rest here. Command Centre stores
        per-person daily commit counts only, never commit contents or SHAs. The unmatched list below is
        replaced on every sync (top 50), and mappings apply from the next sync. On public tracked repos,
        the unmatched list can include commit-author emails of people outside your organisation: it is
        replaced wholesale by every sync, not accumulated.
      </p>

      {loadFailed ? (
        <div className="px-4 pb-4">
          <Notice tone="warn">Couldn&apos;t load mapping data. Refresh to retry.</Notice>
        </div>
      ) : (
        <>
          <div className="px-4 pt-3 border-t border-[#F2F2F2]">
            <SubHead>Unmatched authors, current window</SubHead>
          </div>
          {unmatched.length === 0 ? (
            <div className="px-4 pb-3"><Muted>None: every commit author in the window matched a person.</Muted></div>
          ) : (
            <div className="pb-1">
              {unmatched.map((u, i) => (
                <div key={u.identity} className={cx('flex items-center gap-2 px-4 py-2', i > 0 && 'border-t border-[#F2F2F2]')}>
                  <span className="text-[14px] font-medium text-[#0A0A0A] truncate min-w-0 flex-1" title={u.identity}>{u.identity}</span>
                  <span className="text-[13px] text-[#8F8F8F] tabular-nums shrink-0">{u.commit_count} commit{u.commit_count === 1 ? '' : 's'}</span>
                  <select
                    value={pick[u.identity] ?? ''}
                    onChange={e => setPick(p => ({ ...p, [u.identity]: e.target.value }))}
                    aria-label={`Map ${u.identity} to a user`}
                    className={cx(B.select, 'shrink-0 max-w-[200px]')}
                  >
                    <option value="">Map to user…</option>
                    {users.map(usr => <option key={usr.id} value={usr.id}>{usr.display_name || usr.email}</option>)}
                  </select>
                  <button
                    type="button"
                    onClick={() => mapIdentity(u.identity)}
                    disabled={busy || !pick[u.identity]}
                    className={cx(B.secondary, 'shrink-0')}
                  >Map</button>
                </div>
              ))}
            </div>
          )}

          <div className="px-4 pt-3 border-t border-[#F2F2F2]">
            <SubHead>Identity mappings</SubHead>
          </div>
          {mappings.length === 0 ? (
            <div className="px-4 pb-3"><Muted>No manual mappings yet.</Muted></div>
          ) : (
            <div className="pb-1">
              {mappings.map((m, i) => (
                <div key={m.identity} className={cx('flex items-center gap-2 px-4 py-2', i > 0 && 'border-t border-[#F2F2F2]')}>
                  <span className="text-[14px] text-[#0A0A0A] truncate min-w-0 flex-1" title={m.identity}>{m.identity}</span>
                  <span className="text-[13px] text-[#666666] shrink-0">→ {m.display_name}</span>
                  <button
                    type="button"
                    onClick={() => removeMapping(m.identity)}
                    disabled={busy}
                    className="text-[13px] font-medium text-[#B42318] hover:underline disabled:opacity-50 shrink-0"
                  >Remove</button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
