// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useCallback, useEffect, useState } from 'react';
import { Panel, Muted, B, T, cx } from '@/components/precision/ui';

interface ReviewItem { id: number; content: string | null; taskType: string | null }
interface OpenCycle { id: number; period: string; nSampled: number; nReviewed: number; items: ReviewItem[] }
interface HistoryRow { id: number; period: string; agreementPct: number | null; kappa: number | null; nReviewed: number }
interface Published { agreementPct: number; kappa: number; n: number; cycles: number }
interface AuditData { published: Published | null; open: OpenCycle | null; history: HistoryRow[]; kappaFloor: number }

function priorMonth(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export default function AuditTab() {
  const [data, setData] = useState<AuditData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [period, setPeriod] = useState(priorMonth());

  const load = useCallback(() => {
    setLoading(true);
    fetch('/api/pulse/admin/audit')
      .then(r => r.json())
      .then(d => setData(d))
      .catch(() => setMsg('Failed to load audit data'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const post = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/pulse/admin/audit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) { setMsg(j.error || 'Action failed'); return null; }
      return j;
    } finally { setBusy(false); }
  }, []);

  const review = useCallback(async (itemId: number, humanTier: number) => {
    const j = await post({ action: 'review', itemId, humanTier });
    if (j) load();
  }, [post, load]);

  if (loading) return <Panel><Muted>Loading audit…</Muted></Panel>;
  if (!data) return <Panel><Muted>No audit data.</Muted></Panel>;

  const { published, open, history, kappaFloor } = data;
  const nextItem = open?.items[0] ?? null;
  const belowFloor = published && published.kappa < kappaFloor;

  return (
    <div className="flex flex-col gap-4">
      {/* Published headline */}
      <Panel title="Human agreement" subtitle="How often a human reviewer agrees with the classifier's tier">
        {published ? (
          <div className="flex flex-col gap-1.5">
            <p className="m-0 flex items-baseline flex-wrap gap-x-2">
              <span className="text-[24px] leading-7 font-semibold tracking-[-0.02em] tabular-nums text-[#0A0A0A]">
                {Math.round(published.agreementPct * 100)}%
              </span>
              <span className="text-[13px] text-[#8F8F8F] tabular-nums">
                last quarter, n={published.n} · {published.cycles} cycle{published.cycles === 1 ? '' : 's'}
              </span>
            </p>
            <p className={cx('m-0 text-[14px] tabular-nums', belowFloor ? 'text-[#B54708] font-medium' : 'text-[#333333]')}>
              Cohen&apos;s κ (quadratic-weighted): {published.kappa.toFixed(2)}
              {belowFloor && `: below the ${kappaFloor} substantial-agreement floor; review the tier rubric.`}
            </p>
            <p className="m-0 text-[13px] text-[#8F8F8F]">Reweighted to the production tier×confidence mix. This is the standing answer to &ldquo;how do you know the tiers are right?&rdquo;</p>
          </div>
        ) : (
          <Muted>No scored audit cycle yet. Draw a sample and review it to publish the first figure.</Muted>
        )}
      </Panel>

      {/* Draw / open cycle */}
      {!open ? (
        <Panel title="Start an audit cycle">
          <p className="m-0 mb-3 text-[13px] text-[#666666] leading-5">Draws a stratified 50-item sample from the period, oversampling the hard 0.5–0.8 confidence band. Reproducible from a period-derived seed.</p>
          <div className="flex items-center gap-2">
            <input value={period} onChange={e => setPeriod(e.target.value)} placeholder="YYYY-MM"
                   aria-label="Audit period (YYYY-MM)"
                   className={cx(B.input, 'w-32 tabular-nums')} />
            <button type="button" disabled={busy} onClick={async () => { const j = await post({ action: 'draw', period }); if (j) load(); }}
                    className={B.primary}>
              Draw sample
            </button>
          </div>
        </Panel>
      ) : (
        <Panel
          title={`Blind review: ${open.period}`}
          right={<span className="text-[13px] text-[#8F8F8F] tabular-nums">{open.nReviewed} of {open.nSampled} reviewed</span>}
        >
          {nextItem ? (
            <div>
              <p className="m-0 mb-1.5 text-[13px] text-[#8F8F8F] tabular-nums">Task {open.nReviewed + 1} of {open.nSampled}{nextItem.taskType ? ` · ${nextItem.taskType}` : ''}</p>
              <div className="bg-[#FAFAFA] border border-[#EAEAEA] rounded-[10px] p-3 text-[14px] text-[#0A0A0A] mb-3 min-h-[60px] whitespace-pre-wrap">
                {nextItem.content || <span className="text-[#8F8F8F]">(no content preview)</span>}
              </div>
              <p className="m-0 mb-2 text-[13px] text-[#666666]">Assign the delegation tier you judge this to be (the classifier&apos;s tier is hidden):</p>
              <div className="flex gap-2">
                {[1, 2, 3].map(t => (
                  <button key={t} type="button" disabled={busy} onClick={() => review(nextItem.id, t)}
                          className={cx(B.secondary, 'flex-1 py-2')}>
                    Tier {t}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-start gap-3">
              <p className="m-0 text-[14px] text-[#1A7F37]">All {open.nSampled} items reviewed.</p>
              <button type="button" disabled={busy} onClick={async () => { const j = await post({ action: 'score', cycleId: open.id }); if (j) { setMsg(`Scored: ${Math.round(j.agreementPct * 100)}% agreement, κ=${j.kappa.toFixed(2)}`); load(); } }}
                      className={B.primary}>
                Score this cycle
              </button>
            </div>
          )}
        </Panel>
      )}

      {msg && <p className="m-0 text-[13px] text-[#666666]">{msg}</p>}

      {/* History */}
      {history.length > 0 && (
        <Panel title="Scored cycles" flush>
          <table className={T.table}>
            <thead>
              <tr className={T.headRow}>
                <th scope="col" className={T.th}>Period</th>
                <th scope="col" className={T.thRight}>Agreement</th>
                <th scope="col" className={T.thRight}>κ</th>
                <th scope="col" className={T.thRight}>Reviewed</th>
              </tr>
            </thead>
            <tbody>
              {history.map(h => (
                <tr key={h.id} className={T.row}>
                  <td className={T.td}>{h.period}</td>
                  <td className={T.tdRight}>{h.agreementPct === null ? '—' : `${Math.round(h.agreementPct * 100)}%`}</td>
                  <td className={T.tdRight}>{h.kappa === null ? '—' : h.kappa.toFixed(2)}</td>
                  <td className={T.tdRight}>{h.nReviewed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  );
}
