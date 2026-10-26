// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import { Panel, Tag, Pill, Muted, SubHead, SEVERITY_COLOR } from '@/components/precision/ui';

interface Recommendation {
  priority: string;
  title: string;
  detail: string;
  category: string;
}

interface BriefingData {
  briefing: string;
  risk_score: number;
  risk_label: string;
  risk_reasoning: string;
  recommendations: Recommendation[];
  adoption_headline: string;
  cached?: boolean;
  generatedAt?: number;
}

/** Category icons, as the original dashboard had them. */
const CATEGORY_ICONS: Record<string, string> = {
  security: '🛡',
  adoption: '🚀',
  governance: '📋',
  efficiency: '⚡',
  use_case: '🎯',
  intent: '🔎',
};

// Ring colour by risk level, as the original gauge had it: green low, amber moderate/elevated, red high/critical.
const RISK_RING: Record<'good' | 'warn' | 'bad', string> = { good: '#1A7F37', warn: '#DC8A00', bad: '#D92D20' };

function RiskGauge({ score, tone }: { score: number; tone: 'good' | 'warn' | 'bad' }) {
  const r = 52;
  const circumference = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, score));
  return (
    <div className="relative w-[120px] h-[120px]">
      <svg className="w-[120px] h-[120px] -rotate-90" viewBox="0 0 120 120" aria-hidden="true">
        <circle cx="60" cy="60" r={r} fill="none" strokeWidth="8" stroke="#F2F2F2" />
        <circle
          cx="60" cy="60" r={r} fill="none" strokeWidth="8"
          stroke={RISK_RING[tone]}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference - (clamped / 100) * circumference}
          style={{ transition: 'stroke-dashoffset 1s ease-out' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center" role="img" aria-label={`Organisation risk ${clamped} out of 100`}>
        <span className="text-[28px] leading-8 font-semibold tracking-[-0.02em] tabular-nums text-[#0A0A0A]">{clamped}</span>
        <span className="text-[13px] text-[#8F8F8F]">/ 100</span>
      </div>
    </div>
  );
}

const RISK_TONE: Record<string, 'good' | 'warn' | 'bad'> = {
  low: 'good',
  moderate: 'warn',
  elevated: 'warn',
  high: 'bad',
  critical: 'bad',
};

const CATEGORY_LABELS: Record<string, string> = {
  security: 'Security',
  adoption: 'Adoption',
  governance: 'Governance',
  efficiency: 'Efficiency',
  use_case: 'Use case',
  intent: 'Intent',
};

function formatBriefingAge(generatedAt: number): string {
  const seconds = Math.floor((Date.now() - generatedAt) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function Spinner() {
  return <span className="inline-block w-3.5 h-3.5 border-2 border-[#DADADA] border-t-[#245BF3] rounded-full animate-spin" aria-hidden="true" />;
}

const BADGE = <Tag tone="judged">AI summary</Tag>;

export default function AiBriefing({ refreshKey }: { refreshKey?: number }) {
  const [data, setData] = useState<BriefingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Force fresh on: refresh button click (refreshKey > 0) or F5 full page reload
    // Only use cache on SPA navigation (e.g. clicking back to dashboard from another page)
    const isPageReload = typeof window !== 'undefined' &&
      (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming)?.type === 'reload';
    const force = (refreshKey ?? 0) > 0 || isPageReload;
    if (force && data) {
      // Already have data — show a subtle "refreshing" overlay instead of full spinner
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    fetch(`/api/ai/briefing${force ? '?force=1' : ''}`)
      .then(r => {
        if (!r.ok) throw new Error('Failed to load');
        return r.json();
      })
      .then(d => { if (d.briefing) setData(d); else setError(d.error || 'No data'); })
      .catch(() => setError('AI briefing unavailable'))
      .finally(() => { setLoading(false); setRefreshing(false); });
  // Runs on refresh only; `data` decides spinner vs overlay and must not trigger a refetch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  if (loading) {
    return (
      <Panel title="Intelligence briefing" badge={BADGE}>
        <div className="flex items-center gap-2">
          <Spinner />
          <Muted>Analysing organisational data...</Muted>
        </div>
      </Panel>
    );
  }

  if (error || !data) {
    return (
      <Panel title="Intelligence briefing" badge={BADGE}>
        {/* A missing key is handled by the dashboard itself; reaching here means generation failed. */}
        <Muted>The briefing could not be generated just now. Use Refresh to try again.</Muted>
      </Panel>
    );
  }

  const riskTone = RISK_TONE[data.risk_label] ?? 'warn';

  return (
    <>
      {/* Executive briefing + risk score */}
      <Panel
        title="Intelligence briefing"
        badge={BADGE}
        subtitle={`Powered by Claude · Generated ${data.generatedAt ? formatBriefingAge(data.generatedAt) : 'just now'}${data.cached ? ' (cached)' : ''}`}
        right={refreshing ? (
          <span className="flex items-center gap-2 text-[13px] text-[#8F8F8F]"><Spinner />Refreshing briefing...</span>
        ) : undefined}
        className={refreshing ? 'opacity-60' : undefined}
        flush
      >
        <div className="grid grid-cols-1 lg:grid-cols-3">
          {/* Briefing text */}
          <div className="lg:col-span-2 p-4 flex flex-col gap-3">
            <p className="m-0 text-[14px] leading-[1.6] text-[#333333]">{data.briefing}</p>
            {data.adoption_headline && (
              <div className="border border-[#EAEAEA] bg-[#FAFAFA] rounded-[10px] px-3 py-2.5">
                <SubHead>Adoption momentum</SubHead>
                <p className="m-0 text-[14px] text-[#333333]">{data.adoption_headline}</p>
              </div>
            )}
          </div>

          {/* Risk score */}
          <div className="p-4 border-t lg:border-t-0 lg:border-l border-[#F2F2F2] flex flex-col items-center justify-center gap-3">
            <span className="text-[13px] text-[#666666]">Organisation risk</span>
            <RiskGauge score={data.risk_score} tone={riskTone} />
            <span><Pill tone={riskTone}><span className="capitalize">{data.risk_label}</span>&nbsp;risk</Pill></span>
          </div>
        </div>
      </Panel>

      {/* AI recommendations */}
      <Panel
        title="AI recommendations"
        badge={<Tag tone="judged">AI-judged</Tag>}
        subtitle="Prioritised by impact"
        right={<Tag>{data.recommendations.length} actions</Tag>}
        flush
      >
        {/* One box per recommendation, three to a row, edged in its priority colour. */}
        <ul className="m-0 p-4 list-none grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
          {data.recommendations.map((rec, i) => {
            const colour = SEVERITY_COLOR[rec.priority] ?? SEVERITY_COLOR.low;
            return (
              <li
                key={i}
                className="bg-[#F8F9FB] rounded-[12px] px-4 py-3 flex flex-col gap-1.5"
                style={{ borderLeft: `3px solid ${colour}` }}
              >
                <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.04em]" style={{ color: colour }}>
                  <span className="text-[14px] leading-none" role="img" aria-label={CATEGORY_LABELS[rec.category] ?? rec.category} title={CATEGORY_LABELS[rec.category] ?? rec.category}>
                    {CATEGORY_ICONS[rec.category] ?? '📌'}
                  </span>
                  <span>{rec.priority}</span>
                </div>
                <span className="text-[14px] font-semibold text-[#0A0A0A] leading-5">{rec.title}</span>
                <p className="m-0 text-[13px] leading-5 text-[#4D4D4D]">{rec.detail}</p>
              </li>
            );
          })}
        </ul>
      </Panel>
    </>
  );
}
