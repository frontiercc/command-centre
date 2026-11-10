// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * A person's admin page: where their department came from, when the directory
 * last confirmed it, Return to directory for a department set by hand, and
 * their department changes. Hidden on a hub that has never used department
 * sync and has no changes to show for this person.
 */
import { useCallback, useEffect, useState } from 'react';
import { Panel, Muted, T, B } from '@/components/precision/ui';
import { useToast } from '@/components/shared/ToastProvider';

interface Change { from: string | null; to: string | null; source: string; changedAt: number }
interface Detail {
  syncActive: boolean;
  source: 'directory' | 'manual' | 'other';
  syncedAt: number | null;
  history: Change[];
}

const SOURCE_LABEL: Record<Detail['source'], string> = {
  directory: 'From the directory',
  manual: 'Set by hand',
  other: 'Not from the directory: set by telemetry, an import, or before department sync',
};

function day(epochS: number): string {
  return new Date(epochS * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function PersonDepartmentSync({ userId, version }: {
  userId: string;
  /** Bumped by the page after it saves a department, so this reloads. */
  version: number;
}) {
  const { showToast } = useToast();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [returning, setReturning] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/department-sync/person?userId=${encodeURIComponent(userId)}`);
      setDetail(res.ok ? await res.json() as Detail : null);
    } catch {
      setDetail(null);
    }
  }, [userId]);

  useEffect(() => { void load(); }, [load, version]);

  const returnToDirectory = async () => {
    setReturning(true);
    try {
      const res = await fetch('/api/admin/department-sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'return', kind: 'user', id: userId }),
      });
      if (res.ok) {
        showToast('Returned to the directory. The department updates at the next lookup or sign-in.', 'success');
        await load();
      } else {
        showToast('Could not return to directory', 'error');
      }
    } finally {
      setReturning(false);
    }
  };

  if (!detail || (!detail.syncActive && detail.history.length === 0)) return null;

  return (
    <Panel title="Department source" flush>
      {detail.syncActive && (
        <div className="px-4 py-3 flex items-start gap-4 flex-wrap">
          <div className="flex-1 min-w-0 flex flex-col gap-0.5">
            <span className="text-[14px] text-[#0A0A0A]">{SOURCE_LABEL[detail.source]}</span>
            <span className="text-[13px] text-[#666666]">
              {detail.source === 'manual'
                ? 'Department sync leaves a department set by hand alone until it is returned to the directory.'
                : detail.syncedAt ? `Last confirmed by the directory on ${day(detail.syncedAt)}.` : 'Not yet confirmed by the directory.'}
            </span>
          </div>
          {detail.source === 'manual' && (
            <button type="button" className={B.secondary} disabled={returning} onClick={returnToDirectory}>
              {returning ? 'Returning…' : 'Return to directory'}
            </button>
          )}
        </div>
      )}
      <div className={detail.syncActive ? 'border-t border-[#F2F2F2]' : ''}>
        <div className="px-4 pt-3 pb-1 text-[13px] font-medium text-[#0A0A0A]">Department changes</div>
        {detail.history.length > 0 ? (
          <table className={T.table}>
            <thead>
              <tr className={T.headRow}>
                <th className={T.th}>Date</th>
                <th className={T.th}>From</th>
                <th className={T.th}>To</th>
                <th className={T.th}>How</th>
              </tr>
            </thead>
            <tbody>
              {detail.history.map((c, i) => (
                <tr key={i} className={T.row}>
                  <td className={T.td}>{day(c.changedAt)}</td>
                  <td className={T.tdMute}>{c.from || 'None'}</td>
                  <td className={T.td}>{c.to || 'None'}</td>
                  <td className={T.tdMute}>{c.source === 'directory' ? 'Directory' : 'By hand'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="px-4 pb-3"><Muted>No changes recorded yet.</Muted></div>}
      </div>
    </Panel>
  );
}
