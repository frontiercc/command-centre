// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import { Panel, Tabs, Tag, B, Muted, cx } from '@/components/precision/ui';

interface Candidate {
  id: number;
  title: string;
  body: string | null;
  tier: number | null;
  detected_at: number;
  user_id: string;
  display_name: string | null;
  email: string;
  task_type: string | null;
}

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

function TierBadge({ tier }: { tier: number | null }) {
  if (!tier) return null;
  return <Tag tone="judged">Tier {tier}</Tag>;
}

interface CapabilityQueueProps {
  onCountChange?: (count: number) => void;
}

export default function CapabilityQueue({ onCountChange }: CapabilityQueueProps) {
  const [queueTab, setQueueTab] = useState<'pending' | 'dismissed'>('pending');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [dismissed, setDismissed] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [actioning, setActioning] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgTone, setMsgTone] = useState<'good' | 'neutral' | 'bad'>('neutral');
  // Optional value-attribution step on confirm.
  const [valueFor, setValueFor] = useState<number | null>(null);
  const [vType, setVType] = useState('external_spend_replaced');
  const [vAmount, setVAmount] = useState('');
  const [vPeriod, setVPeriod] = useState('monthly');
  const [vBasis, setVBasis] = useState('');

  function openValuePanel(id: number) {
    setValueFor(id); setVType('external_spend_replaced'); setVAmount(''); setVPeriod('monthly'); setVBasis('');
  }

  function loadCandidates() {
    fetch('/api/pulse/capabilities')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => {
        setCandidates(d.candidates ?? []);
        onCountChange?.(d.pendingCount ?? 0);
      })
      .catch(() => setCandidates([]))
      .finally(() => setLoading(false));
  }

  function loadDismissed() {
    fetch('/api/pulse/capabilities?status=dismissed')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => setDismissed(d.candidates ?? []))
      .catch(() => setDismissed([]))
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadCandidates(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (queueTab === 'dismissed') {
      setLoading(true);
      loadDismissed();
    }
  }, [queueTab]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleAction(id: number, act: 'confirm' | 'dismiss' | 'restore', value?: object) {
    setActioning(id);
    setMsg(null);
    try {
      const res = await fetch('/api/pulse/capabilities', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action: act, ...(value ? { value } : {}) }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "Couldn't save. Try again.");
      }
      setValueFor(null);
      if (act === 'confirm') { setMsg('Confirmed'); setMsgTone('good'); }
      else if (act === 'dismiss') { setMsg('Dismissed'); setMsgTone('neutral'); }
      else { setMsg('Restored'); setMsgTone('good'); }
      setTimeout(() => setMsg(null), 2000);
      if (queueTab === 'dismissed') loadDismissed();
      else loadCandidates();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Action failed');
      setMsgTone('bad');
    } finally {
      setActioning(null);
    }
  }

  function submitWithValue(id: number) {
    const amount = parseFloat(vAmount);
    if (!vAmount || isNaN(amount) || amount < 0) { setMsg('Enter a non-negative amount, or confirm without a value'); setMsgTone('bad'); return; }
    if (!vBasis.trim()) { setMsg('A basis is required whenever you enter an amount'); setMsgTone('bad'); return; }
    handleAction(id, 'confirm', { valueType: vType, valueAmount: amount, valuePeriod: vPeriod, valueBasis: vBasis.trim() });
  }

  const activeList = queueTab === 'pending' ? candidates : dismissed;

  return (
    <Panel
      title="Capability queue"
      badge={queueTab === 'pending' && candidates.length > 0 ? <Tag tone="measured">{candidates.length}</Tag> : undefined}
      flush
    >
      <div className="px-4 pt-1">
        <Tabs
          label="Capability queue"
          value={queueTab}
          onChange={setQueueTab}
          tabs={[{ value: 'pending', label: 'Pending' }, { value: 'dismissed', label: 'Dismissed' }]}
        />
      </div>

      <div className="px-4 pt-3 pb-3 flex flex-col gap-1">
        <Muted>
          {queueTab === 'pending'
            ? 'Confirm capability events to start tracking them. Dismiss false positives.'
            : 'Dismissed candidates. Restore any that were dismissed in error.'}
        </Muted>
        {msg && (
          <p role="status" className={cx('m-0 text-[14px]', msgTone === 'good' ? 'text-[#1A7F37]' : msgTone === 'bad' ? 'text-[#B42318]' : 'text-[#666666]')}>
            {msg}
          </p>
        )}
      </div>

      {loading ? (
        <div className="px-4 pb-4"><Muted>Loading…</Muted></div>
      ) : activeList.length === 0 ? (
        <div className="px-4 pb-4">
          <Muted>
            {queueTab === 'pending'
              ? 'No pending candidates. Capability events will appear here after the classifier runs.'
              : 'No dismissed candidates.'}
          </Muted>
        </div>
      ) : (
        <ul className="m-0 p-0 list-none">
          {activeList.map(c => (
            <li key={c.id} className="px-4 py-3 border-t border-[#F2F2F2]">
              <div className="flex items-start justify-between gap-3 flex-wrap sm:flex-nowrap">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <p className="m-0 text-[14px] font-medium text-[#0A0A0A] truncate">
                      {c.display_name ?? c.email}
                    </p>
                    <TierBadge tier={c.tier} />
                  </div>
                  <p className="m-0 text-[14px] text-[#333333] mb-0.5">{c.title}</p>
                  {c.body && (
                    <p className="m-0 text-[13px] text-[#8F8F8F] line-clamp-2 mb-0.5">&ldquo;{c.body}&rdquo;</p>
                  )}
                  {c.task_type && (
                    <p className="m-0 text-[13px] text-[#8F8F8F]">Task: {c.task_type.replace(/_/g, ' ')}</p>
                  )}
                  <p className="m-0 text-[13px] text-[#8F8F8F] tabular-nums">{formatDate(c.detected_at)}</p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {queueTab === 'pending' ? (
                    <>
                      <button
                        type="button"
                        onClick={() => openValuePanel(c.id)}
                        disabled={actioning === c.id}
                        className={B.primary}
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => handleAction(c.id, 'dismiss')}
                        disabled={actioning === c.id}
                        className={B.secondary}
                      >
                        Dismiss
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleAction(c.id, 'restore')}
                      disabled={actioning === c.id}
                      className={B.secondary}
                    >
                      Restore
                    </button>
                  )}
                </div>
              </div>

              {valueFor === c.id && (
                <div className="mt-3 pt-3 border-t border-[#F2F2F2] flex flex-col gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="m-0 text-[14px] font-medium text-[#0A0A0A]">Attach a value (optional)</p>
                    <Tag tone="judged">Estimate</Tag>
                  </div>
                  <p className="m-0 text-[13px] text-[#8F8F8F]">Manager-attributed estimate, not modelled. Leave blank to just confirm. A basis is required if you enter an amount.</p>
                  <div className="flex flex-wrap gap-2">
                    <select aria-label="Value type" value={vType} onChange={e => setVType(e.target.value)} className={B.select}>
                      <option value="external_spend_replaced">External spend replaced</option>
                      <option value="cost_avoidance">Cost avoidance</option>
                      <option value="time_reclaimed">Time reclaimed</option>
                    </select>
                    <input aria-label="Value amount" value={vAmount} onChange={e => setVAmount(e.target.value)} inputMode="decimal"
                      placeholder={vType === 'time_reclaimed' ? 'hours / month' : 'amount'}
                      className={cx(B.input, 'w-32')} />
                    {vType !== 'time_reclaimed' && (
                      <select aria-label="Value period" value={vPeriod} onChange={e => setVPeriod(e.target.value)} className={B.select}>
                        <option value="monthly">per month</option>
                        <option value="annual">per year</option>
                        <option value="one_off">one-off</option>
                      </select>
                    )}
                  </div>
                  <input aria-label="Value basis" value={vBasis} onChange={e => setVBasis(e.target.value)}
                    placeholder='Basis, e.g. "Replaced monthly contractor scorecard at £1,200/month"'
                    className={cx(B.input, 'w-full')} />
                  <div className="flex gap-2 flex-wrap">
                    <button type="button" onClick={() => submitWithValue(c.id)} disabled={actioning === c.id} className={B.primary}>
                      Confirm with value
                    </button>
                    <button type="button" onClick={() => handleAction(c.id, 'confirm')} disabled={actioning === c.id} className={B.secondary}>
                      Confirm without value
                    </button>
                    <button type="button" onClick={() => setValueFor(null)} disabled={actioning === c.id}
                      className="text-[13px] font-medium text-[#666666] hover:text-[#0A0A0A] px-2 py-1.5 disabled:opacity-50">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
