// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import { Panel, Strip, Figure, Muted, Notice, Tag, Pill, B, T, cx } from '@/components/precision/ui';
import { SaveMsg } from '@/components/admin/precision-admin';

interface TierDay { day: string; tier: number; cnt: number }
interface ConfBucket { bucket: number; cnt: number }
interface FailureRow {
  id: number; classifier_error: string | null; classifier_attempts: number;
  classified_at: number; classifier_model: string;
  content_preview: string | null; user_id: string;
  display_name: string | null; email: string;
}
interface ModelRow {
  classifier_model: string; first_used: number;
  last_used: number; total_classified: number;
}
interface HealthData {
  queueDepth: number;
  tierDist: TierDay[];
  confidenceHist: ConfBucket[];
  failures: FailureRow[];
  modelLog: ModelRow[];
}

function timeAgo(ts: number): string {
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function ConfHistogram({ data }: { data: ConfBucket[] }) {
  const maxCnt = Math.max(...data.map(d => d.cnt), 1);
  const buckets = Array.from({ length: 11 }, (_, i) => {
    const found = data.find(d => d.bucket === i);
    return { bucket: i, cnt: found?.cnt ?? 0 };
  });
  return (
    <div className="flex items-end gap-1 h-16 border-b border-[#F2F2F2]">
      {buckets.map(b => (
        <div key={b.bucket} className="flex-1 flex flex-col items-center gap-1">
          <div
            title={`${b.bucket * 10}%–${b.bucket * 10 + 10}%: ${b.cnt}`}
            style={{ height: `${Math.round((b.cnt / maxCnt) * 52)}px` }}
            className={`w-full rounded-full ${b.bucket >= 7 ? 'bg-[#3D6CE8]' : b.bucket >= 4 ? 'bg-[#8DB2FC]' : 'bg-[#CCD1DB]'}`}
          />
          <span className="text-[11px] text-[#8F8F8F] tabular-nums">{b.bucket * 10}</span>
        </div>
      ))}
    </div>
  );
}

export default function HealthTab() {
  const [data, setData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [retryMsg, setRetryMsg] = useState<string | null>(null);
  const [classifying, setClassifying] = useState(false);
  const [classifyMsg, setClassifyMsg] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    fetch('/api/pulse/admin/health')
      .then(r => r.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const runClassifyNow = async () => {
    setClassifying(true);
    setClassifyMsg(null);
    try {
      const res = await fetch('/api/pulse/admin/classify', { method: 'POST' });
      const d = await res.json();
      if (!res.ok) {
        setClassifyMsg(d.error ?? 'Classification failed.');
      } else {
        setClassifyMsg(d.message ?? `Classified ${d.classified} message(s).`);
        load();
      }
    } catch {
      setClassifyMsg('Request failed.');
    } finally {
      setClassifying(false);
    }
  };

  const retryFailed = async () => {
    setRetrying(true);
    setRetryMsg(null);
    try {
      const res = await fetch('/api/pulse/admin/health', { method: 'POST' });
      const d = await res.json();
      setRetryMsg(`${d.retried} failed classification(s) reset for retry.`);
      load();
    } catch {
      setRetryMsg('Retry failed.');
    } finally {
      setRetrying(false);
    }
  };

  if (loading) return (
    <Panel>
      <Muted>Loading health data…</Muted>
    </Panel>
  );
  if (!data) return (
    <Notice tone="error">Failed to load classifier health.</Notice>
  );

  const tierTotals = data.tierDist.reduce<Record<number, number>>((acc, row) => {
    acc[row.tier] = (acc[row.tier] ?? 0) + row.cnt;
    return acc;
  }, {});
  const totalClassified = Object.values(tierTotals).reduce((a, b) => a + b, 0);

  return (
    <div className="flex flex-col gap-4">

      {/* Top-level stats row */}
      <Strip cols={4}>
        <Figure
          label="Queue depth"
          value={data.queueDepth.toLocaleString()}
          tone={data.queueDepth > 0 ? 'warn' : 'neutral'}
          sub={
            <span className="flex flex-col items-start gap-1.5">
              <span>unclassified messages</span>
              {data.queueDepth > 0 && (
                <button
                  type="button"
                  onClick={runClassifyNow}
                  disabled={classifying}
                  className={B.accent}
                >
                  {classifying ? 'Classifying…' : 'Run now'}
                </button>
              )}
              {classifyMsg && (
                <span className="text-[13px] text-[#333333]">{classifyMsg}</span>
              )}
            </span>
          }
        />
        <Figure label="Classified (30 days)" value={totalClassified.toLocaleString()} />
        <Figure
          label="Failed (pending retry)"
          value={data.failures.length.toLocaleString()}
          tone={data.failures.length > 0 ? 'bad' : 'neutral'}
        />
        <Figure label="Models used" value={data.modelLog.length.toLocaleString()} />
      </Strip>

      {/* Tier distribution + confidence histogram */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Panel title="Tier distribution" subtitle="30 days" badge={<Tag tone="judged">AI-judged</Tag>}>
          {totalClassified === 0 ? (
            <Muted>No classifications in the last 30 days.</Muted>
          ) : (
            <div className="flex flex-col gap-3">
              {[1, 2, 3].map(tier => {
                const cnt = tierTotals[tier] ?? 0;
                const pct = Math.round((cnt / totalClassified) * 100);
                // AI-judged: sky blue steps, light to dark from Tier 1 to Tier 3.
                const colours: Record<number, string> = { 1: '#CCD1DB', 2: '#8DB2FC', 3: '#3D6CE8' };
                const labels: Record<number, string> = { 1: 'Tier 1: Administrative', 2: 'Tier 2: Meaningful', 3: 'Tier 3: Frontier' };
                return (
                  <div key={tier} className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[14px] text-[#0A0A0A]">{labels[tier]}</span>
                      <span className="text-[13px] text-[#666666] tabular-nums">{cnt.toLocaleString()} ({pct}%)</span>
                    </div>
                    <div className="h-1.5 w-full bg-[#F2F2F2] rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: colours[tier] }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        <Panel title="Confidence distribution" badge={<Tag tone="judged">AI-judged</Tag>}>
          <p className="m-0 mb-3 text-[13px] text-[#8F8F8F] leading-5">
            Darkest = ≥70% · middle = 40–70% · lightest = &lt;40%. A spike in the low buckets means the classifier is uncertain; consider reviewing your tier descriptions.
          </p>
          {data.confidenceHist.length === 0 ? (
            <Muted>No data yet.</Muted>
          ) : (
            <ConfHistogram data={data.confidenceHist} />
          )}
        </Panel>
      </div>

      {/* Failure log */}
      <Panel
        title="Failure log"
        subtitle={`${data.failures.length}`}
        right={
          <>
            {retryMsg && <SaveMsg msg={retryMsg} ok={retryMsg !== 'Retry failed.'} />}
            {data.failures.length > 0 && (
              <button
                type="button"
                onClick={retryFailed}
                disabled={retrying}
                className={B.secondary}
              >
                {retrying ? 'Resetting…' : `Retry all ${data.failures.length} failed`}
              </button>
            )}
          </>
        }
        flush
      >
        {data.failures.length === 0 ? (
          <div className="p-4"><Muted>No failures: classifier is healthy.</Muted></div>
        ) : (
          <div className="overflow-x-auto">
            <table className={T.table}>
              <thead>
                <tr className={T.headRow}>
                  <th scope="col" className={T.th}>When</th>
                  <th scope="col" className={T.th}>User</th>
                  <th scope="col" className={T.th}>Preview</th>
                  <th scope="col" className={T.th}>Error</th>
                  <th scope="col" className={T.thRight}>Attempts</th>
                </tr>
              </thead>
              <tbody>
                {data.failures.map(f => (
                  <tr key={f.id} className={T.row}>
                    <td className={cx(T.tdMute, 'whitespace-nowrap tabular-nums')}>{timeAgo(f.classified_at)}</td>
                    <td className={T.td}>{f.display_name ?? f.email}</td>
                    <td className={cx(T.tdMute, 'max-w-xs')}>
                      {(f.content_preview ?? '').slice(0, 60)}{(f.content_preview ?? '').length > 60 ? '…' : ''}
                    </td>
                    <td className={cx(T.td, 'max-w-xs text-[#B42318]')}>
                      {(f.classifier_error ?? '').slice(0, 80)}
                    </td>
                    <td className={T.tdRight}>{f.classifier_attempts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* Model log */}
      <Panel title="Model history" flush>
        <div className="overflow-x-auto">
          <table className={T.table}>
            <thead>
              <tr className={T.headRow}>
                <th scope="col" className={T.th}>Model</th>
                <th scope="col" className={T.th}>First used</th>
                <th scope="col" className={T.th}>Last used</th>
                <th scope="col" className={T.thRight}>Total classified</th>
              </tr>
            </thead>
            <tbody>
              {data.modelLog.map(m => (
                <tr key={m.classifier_model} className={T.row}>
                  <td className={cx(T.td, 'font-mono text-[13px]')}>{m.classifier_model}</td>
                  <td className={T.tdMute}>{formatDate(m.first_used)}</td>
                  <td className={T.tdMute}>{formatDate(m.last_used)}</td>
                  <td className={cx(T.tdRight, 'font-medium')}>{m.total_classified.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <GovernanceHealthSection />

    </div>
  );
}

// ── Governance Health (moved here from the CIO overview — an ops signal, not an exec one) ──

interface GovernanceHealthData {
  governanceScore: number;
  thresholds?: { critical?: number; warning?: number };
  components: {
    queue_review_latency: { median_hours: number | null; score: number | null };
    alert_acknowledgment: { rate: number | null };
    queue_health: { pending_now: number; score: number | null };
    reviewer_spread: { distinct_reviewers: number; score: number | null };
  };
}

function GovernanceHealthSection() {
  const [gov, setGov] = useState<GovernanceHealthData | null>(null);

  useEffect(() => {
    fetch('/api/pulse/governance-health')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(setGov)
      .catch(() => setGov(null));
  }, []);

  if (!gov) return null;
  const critical = gov.thresholds?.critical ?? 0.3;
  const warning = gov.thresholds?.warning ?? 0.5;
  const state: 'bad' | 'warn' | 'good' =
    gov.governanceScore < critical ? 'bad' : gov.governanceScore < warning ? 'warn' : 'good';

  return (
    <Panel
      title="Governance health"
      subtitle="Automated governance-health score"
      right={
        <span className="flex items-center gap-2">
          {state !== 'good' && <Pill tone={state}>{state === 'bad' ? 'Critical' : 'Warning'}</Pill>}
          <span className={cx('text-[24px] leading-7 font-semibold tracking-[-0.02em] tabular-nums',
            state === 'bad' ? 'text-[#B42318]' : state === 'warn' ? 'text-[#B54708]' : 'text-[#0A0A0A]')}>
            {gov.governanceScore.toFixed(2)}
          </span>
        </span>
      }
      flush
    >
      <p className="m-0 px-4 py-3 text-[13px] text-[#666666] leading-5">
        Automated score for governance quality, derived entirely from observable system activity.
        Combines queue review latency, alert acknowledgment rate, backlog health, and reviewer spread.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 border-t border-[#F2F2F2] [&>*+*]:border-t sm:[&>*+*]:border-t-0 sm:[&>*+*]:border-l [&>*]:border-[#F2F2F2]">
        {[
          { label: 'Queue latency', value: gov.components.queue_review_latency.median_hours !== null ? `${gov.components.queue_review_latency.median_hours.toFixed(0)}h median` : 'No data' },
          { label: 'Alert acknowledgment', value: gov.components.alert_acknowledgment.rate !== null ? `${Math.round(gov.components.alert_acknowledgment.rate * 100)}%` : 'No alerts' },
          { label: 'Queue backlog', value: `${gov.components.queue_health.pending_now} pending` },
          { label: 'Reviewer spread', value: `${gov.components.reviewer_spread.distinct_reviewers} reviewer${gov.components.reviewer_spread.distinct_reviewers === 1 ? '' : 's'}` },
        ].map(c => (
          <div key={c.label} className="px-4 py-3 flex flex-col gap-0.5">
            <span className="text-[13px] text-[#666666]">{c.label}</span>
            <span className="text-[14px] font-medium text-[#0A0A0A] tabular-nums">{c.value}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}
