// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import StatStrip from '@/components/pulse/StatStrip';
import GenerateBriefingButton from '@/components/pulse/GenerateBriefingButton';
import { Panel, PanelFoot, SubHead, Toolbar, Muted, Notice, Tag, Bar, B, T, cx } from '@/components/precision/ui';
import { SaveMsg } from '@/components/admin/precision-admin';

function timeAgo(ts: number): string {
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

interface PulseMetrics {
  oti: number | null; dds: number | null;
  psr: number | null; ors: number | null;
}

interface Classification {
  id: number; tier: number; task_type: string;
  classifier_confidence: number; classifier_status: string;
  classifier_error: string | null; classified_at: number;
  frontier_push_candidate: number; capability_creation_candidate: number;
  content_preview: string | null;
}

interface Briefing {
  body: string; suggestion: string | null; generated_at: number;
}

interface AdminDetail {
  user: { id: string; display_name: string | null; email: string; department: string | null };
  classifications: Classification[];
  briefings: Briefing[];
  pendingCount: number;
  pulseStartAt: number | null;
}

interface MeData {
  metrics: PulseMetrics | null;
  priorMetrics: PulseMetrics | null;
  capabilitiesDetail: { count: number } | null;
  teamMetrics: { ors: number | null } | null;
}

const PAGE_SIZE = 20;

export default function UserDrillDown({ userId }: { userId: string }) {
  const [meData, setMeData] = useState<MeData | null>(null);
  const [detail, setDetail] = useState<AdminDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [expandedBriefing, setExpandedBriefing] = useState<number | null>(null);
  const [startDateInput, setStartDateInput] = useState('');
  const [savingStartDate, setSavingStartDate] = useState(false);
  const [startDateSaved, setStartDateSaved] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch(`/api/pulse/me?userId=${encodeURIComponent(userId)}`).then(r => r.json()),
      fetch(`/api/pulse/admin/users/${encodeURIComponent(userId)}`).then(r => r.json()),
    ]).then(([me, adm]) => {
      setMeData(me);
      setDetail(adm);
      if (adm.pulseStartAt) {
        const dt = new Date(adm.pulseStartAt * 1000);
        setStartDateInput(dt.toISOString().slice(0, 10));
      } else {
        setStartDateInput('');
      }
    }).catch(() => {}).finally(() => setLoading(false));
  }, [userId]);

  if (loading) return <Panel><Muted>Loading…</Muted></Panel>;
  if (!detail || !detail.user) return <Notice tone="error">Failed to load user data.</Notice>;

  const { user, classifications, briefings, pendingCount } = detail;
  const displayName = user.display_name ?? user.email;

  const visibleClassifications = classifications.slice(0, (page + 1) * PAGE_SIZE);
  const hasMore = visibleClassifications.length < classifications.length;

  const m = meData?.metrics;
  const pm = meData?.priorMetrics;
  const delta = (curr: number | null, prior: number | null) =>
    pm ? (curr !== null && prior !== null ? Math.round((curr - prior) * 100) / 100 : null) : undefined;

  async function saveStartDate(dateStr: string | null) {
    setSavingStartDate(true);
    setStartDateSaved(false);
    await fetch(`/api/pulse/user-prefs?userId=${encodeURIComponent(userId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pulse_start_at: dateStr }),
    }).catch(() => {});
    setSavingStartDate(false);
    setStartDateSaved(true);
    setTimeout(() => setStartDateSaved(false), 2000);
  }

  return (
    <div className="flex flex-col gap-4">
      <Toolbar
        left={
          <Link href="/admin/pulse?tab=users" className="text-[13px] text-[#666666] hover:text-[#0A0A0A]">
            ← Back to Users
          </Link>
        }
      />

      {/* Header */}
      <Panel
        title={displayName}
        badge={user.department ? <Tag>{user.department}</Tag> : undefined}
        subtitle={user.email}
        right={<GenerateBriefingButton type="user" userId={userId} onComplete={() => {}} />}
      >
        <div className="flex items-center gap-3 flex-wrap">
          <label htmlFor="pulse-start-date" className="text-[14px] font-medium text-[#0A0A0A] whitespace-nowrap">Pulse active from</label>
          <input
            id="pulse-start-date"
            type="date"
            value={startDateInput}
            onChange={e => { setStartDateInput(e.target.value); setStartDateSaved(false); }}
            className={B.input}
          />
          {startDateInput && (
            <button
              type="button"
              onClick={() => { setStartDateInput(''); saveStartDate(null); }}
              className={B.secondary}
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={() => saveStartDate(startDateInput || null)}
            disabled={savingStartDate}
            className={B.primary}
          >
            {savingStartDate ? 'Saving…' : 'Save'}
          </button>
          {startDateSaved && <SaveMsg msg="Saved" ok />}
        </div>
      </Panel>

      {/* Metrics */}
      {m && (
        <StatStrip
          oti={m.oti} dds={m.dds}
          psr={meData?.capabilitiesDetail?.count ?? m.psr}
          ors={meData?.teamMetrics?.ors ?? m.ors}
          otiDelta={delta(m.oti, pm?.oti ?? null)}
          ddsDelta={delta(m.dds, pm?.dds ?? null)}
          psrDelta={delta(m.psr, pm?.psr ?? null)}
          orsDelta={delta(m.ors, pm?.ors ?? null)}
          hideOrs
        />
      )}

      {/* Classification history */}
      <Panel
        title="Classification history"
        badge={<Tag tone="judged">AI-judged</Tag>}
        right={
          <>
            {pendingCount > 0 && <Tag tone="warn">{pendingCount} pending</Tag>}
            <span className="text-[13px] text-[#8F8F8F] tabular-nums">{classifications.length} total</span>
          </>
        }
        flush
      >
        <div className="overflow-x-auto">
          <table className={T.table}>
            <thead>
              <tr className={T.headRow}>
                <th scope="col" className={T.th}>When</th>
                <th scope="col" className={T.th}>Preview</th>
                <th scope="col" className={T.th}>Tier</th>
                <th scope="col" className={T.th}>Task type</th>
                <th scope="col" className={T.th}>Confidence</th>
                <th scope="col" className={T.th}>Flags</th>
              </tr>
            </thead>
            <tbody>
              {visibleClassifications.map(c => (
                <tr key={c.id} className={T.row}>
                  <td className={cx(T.tdMute, 'whitespace-nowrap tabular-nums')}>{timeAgo(c.classified_at)}</td>
                  <td className={cx(T.tdMute, 'max-w-xs')}>
                    <span title={c.content_preview ?? ''}>
                      {(c.content_preview ?? '').slice(0, 80)}{(c.content_preview ?? '').length > 80 ? '…' : ''}
                    </span>
                  </td>
                  <td className={T.td}>
                    <Tag tone="judged">T{c.tier}</Tag>
                  </td>
                  <td className={T.tdMute}>{c.task_type.replace(/_/g, ' ')}</td>
                  <td className={T.td}>
                    <div className="flex items-center gap-1.5">
                      <div className="w-16">
                        <Bar pct={Math.round(c.classifier_confidence * 100)} tone={c.classifier_confidence >= 0.7 ? 'judged' : 'warn'} height={4} />
                      </div>
                      <span className="text-[13px] text-[#666666] tabular-nums">{Math.round(c.classifier_confidence * 100)}%</span>
                    </div>
                  </td>
                  <td className={T.td}>
                    <div className="flex gap-1 flex-wrap">
                      {c.frontier_push_candidate === 1 && (
                        <Tag tone="judged" title="Frontier push candidate">★ Frontier</Tag>
                      )}
                      {c.capability_creation_candidate === 1 && (
                        <Tag tone="judged" title="Capability creation candidate">⬟ Capability</Tag>
                      )}
                      {c.classifier_status === 'failed' && (
                        <Tag tone="bad" title={c.classifier_error ?? 'Failed'}>Failed</Tag>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {hasMore && (
          <PanelFoot>
            <button
              type="button"
              onClick={() => setPage(p => p + 1)}
              className={B.link}
            >
              Show more ({classifications.length - visibleClassifications.length} remaining)
            </button>
          </PanelFoot>
        )}
      </Panel>

      {/* Briefing history */}
      <Panel title="Briefing history" subtitle={`${briefings.length}`} flush>
        {briefings.length === 0 ? (
          <div className="p-4"><Muted>No briefings generated yet.</Muted></div>
        ) : (
          <div>
            {briefings.map((b, i) => (
              <div key={b.generated_at} className="border-t border-[#F2F2F2] first:border-t-0">
                <button
                  type="button"
                  aria-expanded={expandedBriefing === i}
                  onClick={() => setExpandedBriefing(expandedBriefing === i ? null : i)}
                  className="w-full flex items-center justify-between px-4 py-2.5 text-[14px] text-left hover:bg-[#FAFAFA]"
                >
                  <span className="text-[#0A0A0A]">
                    {new Date(b.generated_at * 1000).toLocaleDateString('en-GB', {
                      day: 'numeric', month: 'long', year: 'numeric',
                    })}
                    {i === 0 && <span className="ml-2 text-[13px] text-[#245BF3]">(latest)</span>}
                  </span>
                  <span className="text-[13px] text-[#8F8F8F]" aria-hidden="true">{expandedBriefing === i ? '▲' : '▼'}</span>
                </button>
                {expandedBriefing === i && (
                  <div className="px-4 pb-4">
                    {b.body.split('\n\n').filter(p => p.trim()).map((p, j) => (
                      <p key={j} className="m-0 mt-2 text-[14px] text-[#333333] leading-6">
                        {p}
                      </p>
                    ))}
                    {b.suggestion && (
                      <div className="mt-3 pt-3 border-t border-[#F2F2F2]">
                        <SubHead>Recommendation</SubHead>
                        <p className="m-0 text-[14px] text-[#333333]">{b.suggestion}</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
