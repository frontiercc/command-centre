// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import { Panel, Muted, B, cx } from '@/components/precision/ui';
import { SaveMsg } from '@/components/admin/precision-admin';

interface TeamBaseline {
  teamId: string;
  teamName: string;
  baselineProcessCount: number | null;
  suggestion: number;
  confirmedCapabilities: number;
}

export default function PsrBaselines() {
  const [teams, setTeams] = useState<TeamBaseline[]>([]);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});

  function load() {
    setLoading(true);
    fetch('/api/admin/pulse/psr-baselines')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(d => {
        const rows: TeamBaseline[] = d.teams ?? [];
        setTeams(rows);
        setDrafts(
          Object.fromEntries(
            rows.map(t => [t.teamId, t.baselineProcessCount === null ? '' : String(t.baselineProcessCount)])
          )
        );
      })
      .catch(() => setTeams([]))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  async function handleSave(teamId: string) {
    setSaving(teamId);
    setMsg(m => ({ ...m, [teamId]: '' }));
    const raw = drafts[teamId];
    const baselineProcessCount = raw === '' || raw === undefined ? null : Number(raw);
    try {
      const res = await fetch('/api/admin/pulse/psr-baselines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId, baselineProcessCount }),
      });
      if (!res.ok) throw new Error("Couldn't save. Try again.");
      setMsg(m => ({ ...m, [teamId]: 'Saved' }));
      setTimeout(() => setMsg(m => ({ ...m, [teamId]: '' })), 2000);
      load();
    } catch {
      setMsg(m => ({ ...m, [teamId]: 'Save failed' }));
    } finally {
      setSaving(null);
    }
  }

  return (
    <Panel title="Process baselines" flush>
      <p className="m-0 px-4 pt-3 pb-3 text-[13px] text-[#666666] leading-5">
        The share of each department&apos;s processes handed to Claude needs a baseline process count: the number
        of manual or recurring processes a department could plausibly substitute with AI. Set it here,
        or use the suggestion drawn from distinct task types that department has actually run in
        the last 30 days.
      </p>

      {loading ? (
        <div className="px-4 pb-4"><Muted>Loading…</Muted></div>
      ) : teams.length === 0 ? (
        <div className="px-4 pb-4">
          <Muted>
            No departments found yet. PSR needs users assigned to a department (admin_users.department)
            and a baseline process count before it can be computed.
          </Muted>
        </div>
      ) : (
        <div>
          {teams.map(t => (
            <div key={t.teamId} className="px-4 py-3 border-t border-[#F2F2F2]">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="m-0 text-[14px] font-medium text-[#0A0A0A]">{t.teamName}</p>
                  <p className="m-0 mt-0.5 text-[13px] text-[#8F8F8F] tabular-nums">
                    Suggested from your data: {t.suggestion} distinct recurring task types (last 30d)
                    {t.confirmedCapabilities > 0 && ` · ${t.confirmedCapabilities} confirmed capabilities`}
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={drafts[t.teamId] ?? ''}
                    onChange={e => setDrafts(d => ({ ...d, [t.teamId]: e.target.value }))}
                    placeholder="Not set"
                    aria-label={`Baseline process count for ${t.teamName}`}
                    className={cx(B.input, 'w-24 tabular-nums')}
                  />
                  <button
                    type="button"
                    onClick={() => setDrafts(d => ({ ...d, [t.teamId]: String(t.suggestion) }))}
                    className={B.secondary}
                  >
                    Use suggestion
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSave(t.teamId)}
                    disabled={saving === t.teamId}
                    className={B.primary}
                  >
                    {saving === t.teamId ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
              {msg[t.teamId] && (
                <p className="m-0 mt-2"><SaveMsg msg={msg[t.teamId]} ok={msg[t.teamId] === 'Saved'} /></p>
              )}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
