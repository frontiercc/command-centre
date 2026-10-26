// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import { Panel, Strip, Figure, Tag, Notice, Muted, B, T, cx } from '@/components/precision/ui';

interface QueueDepth { final: number; provisional: number; finalise: number; total: number }
interface TierDistribution { tier1: number; tier2: number; tier3: number }
interface FailureRow {
  session_id: string;
  user_id: string | null;
  classifier_model: string | null;
  error: string | null;
  classified_at: number;
}
interface TierDef { name: string; description: string }
interface CodeClassifierConfig {
  tiers: { tier1: TierDef; tier2: TierDef; tier3: TierDef };
}
interface ClassifierHealthData {
  enabled: boolean;
  model: string;
  lastRun: string | null;
  classified: number;
  failed: number;
  queue: QueueDepth;
  tierDistribution: TierDistribution;
  confidenceHistogram: number[];
  currentFailures: FailureRow[];
  config?: CodeClassifierConfig;
}

function timeAgo(ts: number): string {
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Confidence is AI-judged: sky blue steps, darkest for the most confident buckets.
const CONF_HIGH = '#3D6CE8';
const CONF_MID = '#8DB2FC';
const CONF_LOW = '#CCD1DB';

function ConfHistogram({ data }: { data: number[] }) {
  const maxCnt = Math.max(...data, 1);
  return (
    <div className="flex items-end gap-1">
      {data.map((cnt, i) => (
        <div key={i} className="flex-1 flex flex-col items-center gap-1">
          <div className="w-full flex items-end h-[52px] border-b border-[#F2F2F2]">
            <div
              title={`${(i / 10).toFixed(1)}: ${cnt}`}
              style={{
                height: `${Math.round((cnt / maxCnt) * 52)}px`,
                background: i >= 7 ? CONF_HIGH : i >= 4 ? CONF_MID : CONF_LOW,
              }}
              className="w-full rounded-full"
            />
          </div>
          <span className="text-[11px] text-[#8F8F8F] tabular-nums">{(i / 10).toFixed(1)}</span>
        </div>
      ))}
    </div>
  );
}

function Swatch({ colour, children }: { colour: string; children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: colour }} />
      {children}
    </span>
  );
}

export default function CodeClassifierHealthTab() {
  const [data, setData] = useState<ClassifierHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [runMsg, setRunMsg] = useState<string | null>(null);
  const [retryMsg, setRetryMsg] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    fetch('/api/pulse/code/classifier')
      .then(r => r.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const runNow = async () => {
    setBusy(true);
    setRunMsg(null);
    try {
      const res = await fetch('/api/pulse/code/classifier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'run-now' }),
      });
      const d = await res.json();
      if (!res.ok) {
        setRunMsg(d.error ?? 'Run failed.');
      } else {
        setRunMsg(`Cleared ${d.classified + d.failed}; ${d.remaining} remaining`);
        load();
      }
    } catch {
      setRunMsg('Request failed.');
    } finally {
      setBusy(false);
    }
  };

  const retryFailed = async () => {
    setBusy(true);
    setRetryMsg(null);
    try {
      const res = await fetch('/api/pulse/code/classifier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retry-failed' }),
      });
      const d = await res.json();
      if (!res.ok) {
        setRetryMsg(d.error ?? 'Retry failed.');
      } else {
        setRetryMsg(`${d.cleared} failed session(s) reset for retry.`);
        load();
      }
    } catch {
      setRetryMsg('Request failed.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return (
    <Panel>
      <Muted>Loading classifier health…</Muted>
    </Panel>
  );
  if (!data) return (
    <Notice tone="error">Failed to load classifier health.</Notice>
  );

  if (!data.enabled) {
    return (
      <Panel>
        <p className="m-0 text-[14px] text-[#666666]">
          The session classifier is disabled. Enable it on the Overview tab.
        </p>
      </Panel>
    );
  }

  if (data.queue.total === 0 && data.classified === 0 && data.failed === 0) {
    return (
      <Panel>
        <Muted>No classified sessions yet.</Muted>
      </Panel>
    );
  }

  const tierMax = Math.max(data.tierDistribution.tier1, data.tierDistribution.tier2, data.tierDistribution.tier3, 1);
  // Tiers are AI-judged: sky blue, deepening from Tier 1 to Tier 3.
  const tierRows: Array<{ key: keyof TierDistribution; label: string; colour: string }> = [
    { key: 'tier1', label: data.config?.tiers?.tier1?.name || 'Tier 1', colour: '#CCD1DB' },
    { key: 'tier2', label: data.config?.tiers?.tier2?.name || 'Tier 2', colour: '#8DB2FC' },
    { key: 'tier3', label: data.config?.tiers?.tier3?.name || 'Tier 3', colour: '#3D6CE8' },
  ];
  const hasConfidenceData = data.confidenceHistogram.some(c => c > 0);

  return (
    <div className="flex flex-col gap-4">

      {/* Queue + status figures */}
      <Strip cols={6}>
        <Figure
          label="Awaiting classification"
          value={data.queue.final}
          tone={data.queue.final > 0 ? 'warn' : 'neutral'}
        />
        <Figure label="Provisional (long-running)" value={data.queue.provisional} />
        <Figure label="Awaiting finalisation" value={data.queue.finalise} />
        <Figure label="Classified" value={data.classified} />
        <Figure label="Failed" value={data.failed} tone={data.failed > 0 ? 'bad' : 'neutral'} />
        <Figure
          label="Last run"
          value={
            <span className="text-[14px] leading-5 font-medium tracking-normal">
              {data.lastRun ? new Date(data.lastRun).toLocaleString() : 'Never'}
            </span>
          }
        />
      </Strip>

      {/* Actions */}
      <Panel>
        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={runNow}
            disabled={busy || !data.enabled}
            className={B.accent}
          >
            {busy ? 'Working…' : 'Run now'}
          </button>
          {data.failed > 0 && (
            <button
              type="button"
              onClick={retryFailed}
              disabled={busy}
              className={B.secondary}
            >
              Retry failed
            </button>
          )}
          {runMsg && <span className="text-[13px] text-[#666666]">{runMsg}</span>}
          {retryMsg && <span className="text-[13px] text-[#666666]">{retryMsg}</span>}
        </div>
      </Panel>

      {/* Tier distribution + confidence histogram */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Panel title="Tier distribution" right={<Tag tone="judged">AI-judged</Tag>}>
          <div className="flex flex-col gap-3">
            {tierRows.map(row => {
              const cnt = data.tierDistribution[row.key];
              const widthPct = Math.round((cnt / tierMax) * 100);
              return (
                <div key={row.key} className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[14px] text-[#0A0A0A] truncate">{row.label}</span>
                    <span className="text-[13px] text-[#666666] tabular-nums">{cnt}</span>
                  </div>
                  <div className="h-1.5 bg-[#F2F2F2] rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${widthPct}%`, background: row.colour }} />
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel title="Confidence distribution" right={<Tag tone="judged">AI-judged</Tag>}>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-[#666666]">
              <Swatch colour={CONF_HIGH}>0.7 and above</Swatch>
              <Swatch colour={CONF_MID}>0.4 to 0.7</Swatch>
              <Swatch colour={CONF_LOW}>below 0.4</Swatch>
            </div>
            <p className="m-0 text-[13px] text-[#8F8F8F] leading-5">
              A spike in the low buckets means the classifier is uncertain: consider reviewing your tier descriptions.
            </p>
            {!hasConfidenceData ? (
              <Muted>No data yet.</Muted>
            ) : (
              <ConfHistogram data={data.confidenceHistogram} />
            )}
          </div>
        </Panel>
      </div>

      {/* Current failures */}
      <Panel
        title="Current failures"
        badge={<Tag tone={data.currentFailures.length > 0 ? 'bad' : 'neutral'}>{data.currentFailures.length}</Tag>}
        subtitle="Sessions currently in a failed state (cleared automatically on a successful re-run)."
        flush
      >
        {data.currentFailures.length === 0 ? (
          <div className="px-4 py-3"><Muted>No current failures.</Muted></div>
        ) : (
          <div className="overflow-x-auto">
            <table className={T.table}>
              <thead>
                <tr className={T.headRow}>
                  <th className={T.th}>Session</th>
                  <th className={T.th}>User</th>
                  <th className={T.th}>Model</th>
                  <th className={T.th}>Error</th>
                  <th className={T.th}>When</th>
                </tr>
              </thead>
              <tbody>
                {data.currentFailures.map(f => (
                  <tr key={f.session_id} className={T.row}>
                    <td className={cx(T.tdMute, 'font-mono text-[13px] max-w-[10rem] truncate')} title={f.session_id}>{f.session_id}</td>
                    <td className={T.tdMute}>{f.user_id ?? '—'}</td>
                    <td className={T.tdMute}>{f.classifier_model ?? '—'}</td>
                    <td className={cx(T.td, 'text-[#B42318] max-w-xs')}>{(f.error ?? '').slice(0, 80)}</td>
                    <td className={cx(T.tdMute, 'whitespace-nowrap')}>{timeAgo(f.classified_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

    </div>
  );
}
