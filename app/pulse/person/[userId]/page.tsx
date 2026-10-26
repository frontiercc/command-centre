// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import Sparkline from '@/components/pulse/Sparkline';
import { formatCurrency, formatTokens, formatDuration } from '@/components/pulse/code/CodeStatStrip';
import HumanTimeCard, { type HumanTimeSummary } from '@/components/pulse/HumanTimeCard';
import { PageBody, Toolbar, Panel, PanelFoot, SubHead, Figure, Tag, Notice, Muted, B, cx, type Tone } from '@/components/precision/ui';

interface SeriesPoint { weekStart: number; value: number | null; partial: boolean }

interface Person360Data {
  userId: string;
  displayName: string | null;
  department: string | null;
  cowork: { tierCounts: { t1: number; t2: number; t3: number }; dds: number | null; oti: number | null } | null;
  code: {
    spendUsd: number | null; sessions: number; commits: number; autonomy: number | null;
    engagedHours: number | null; linesAdded: number; editAcceptRate: number | null;
  } | null;
  chat: { messages7d: number } | null;
  combinedSpend: { codeUsd: number | null; coworkUsd: number; totalUsd: number | null; totalIsPartial?: boolean };
  weekly: { codeSpend: SeriesPoint[]; coworkEvents: SeriesPoint[] };
  humanTime?: { cowork: HumanTimeSummary | null; code: HumanTimeSummary | null } | null;
  canSeeSpendReview?: boolean;
}

/** Figures inside a flush panel, joined by hairlines (same grammar as Strip). */
function FigureGrid({ children, cols }: { children: ReactNode; cols: 2 | 3 }) {
  return (
    <div className={cx('grid grid-cols-1', cols === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2',
      '[&>*]:border-[#EAEAEA] [&>*+*]:border-t sm:[&>*+*]:border-t-0 sm:[&>*+*]:border-l')}>
      {children}
    </div>
  );
}

const TIER_SWATCH = ['bg-[#CCD1DB]', 'bg-[#8DB2FC]', 'bg-[#3D6CE8]'];

function SparkBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="px-4 py-3 border-t border-[#EAEAEA]">
      <SubHead>{label}</SubHead>
      {children}
    </div>
  );
}

function fig(label: string, value: string, sub?: string, tone: Tone = 'neutral') {
  return <Figure label={label} value={value} sub={sub} tone={value === '—' ? 'neutral' : tone} />;
}

export default function Person360Page() {
  const params = useParams<{ userId: string }>();
  const userId = decodeURIComponent(params.userId);
  const router = useRouter();

  const [data, setData] = useState<Person360Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/session')
      .then(r => r.json())
      .then(d => {
        if (!d.authenticated) { router.replace('/audit'); return; }
        const role = d.user?.role ?? '';
        if (!['admin', 'manager', 'viewer', 'cowork', 'pulse', 'code'].includes(role)) {
          router.replace('/audit');
        }
      })
      .catch(() => router.replace('/audit'));
  }, [router]);

  useEffect(() => {
    if (!userId) return;
    fetch(`/api/pulse/person/${encodeURIComponent(userId)}`)
      .then(async r => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Couldn't load this page. Try again.");
        return r.json();
      })
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [userId]);

  if (loading) return (
    <>
      <TopBar title="Person 360" subtitle="Cross-surface view: Cowork, Code, Chat" />
      <LoadingSpinner />
    </>
  );

  if (error) return (
    <>
      <TopBar title="Person 360" subtitle="Cross-surface view: Cowork, Code, Chat" />
      <PageBody>
        <Notice tone="error" title="Failed to load.">{error}</Notice>
      </PageBody>
    </>
  );

  if (!data) return null;

  const name = data.displayName ?? data.userId;
  const { combinedSpend, cowork, code, chat, weekly } = data;

  return (
    <>
      <TopBar title={`Person 360: ${name}`} subtitle={data.department ?? 'No department assigned'} />
      <PageBody>

        {/* Links */}
        <Toolbar>
          {data.canSeeSpendReview && (
            <Link href={`/finops/spend-review/${encodeURIComponent(data.userId)}`} className={B.link}>
              Spend review
            </Link>
          )}
          <Link href="/pulse/users" className={B.link}>
            ← Work Pulse users
          </Link>
          <Link href="/pulse/code/users" className={B.link}>
            ← Developer Pulse users
          </Link>
        </Toolbar>

        <HumanTimeCard summary={data.humanTime?.cowork} surface="cowork" scope="Cowork" />
        <HumanTimeCard summary={data.humanTime?.code} surface="code" scope="Code" />

        {/* Combined AI Spend — measured, blue */}
        <Panel title="Combined AI spend" subtitle="7 days" right={<Tag tone="measured">Measured</Tag>} flush>
          <FigureGrid cols={3}>
            {fig('Total', combinedSpend.totalUsd === null ? '—' : formatCurrency(combinedSpend.totalUsd), undefined, 'measured')}
            {fig('Code', combinedSpend.codeUsd === null ? '—' : formatCurrency(combinedSpend.codeUsd))}
            {fig('Cowork', formatCurrency(combinedSpend.coworkUsd))}
          </FigureGrid>
          {combinedSpend.totalIsPartial && (
            <PanelFoot tone="warn">Excludes unpriced models, so the total is an underestimate.</PanelFoot>
          )}
        </Panel>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
          {/* Cowork column */}
          <Panel title="Work Pulse" right={cowork ? <Tag tone="judged">AI-judged</Tag> : undefined} flush={cowork !== null}>
            {cowork === null ? (
              <Muted>No Work Pulse data for this user yet.</Muted>
            ) : (
              <>
                <FigureGrid cols={2}>
                  {fig('Delegation depth', cowork.dds == null ? '—' : cowork.dds.toFixed(2), 'Average tier, 14 days', 'judged')}
                  {fig('More valuable work', cowork.oti == null ? '—' : `${cowork.oti.toFixed(2)}×`, 'Output against their own start', 'judged')}
                </FigureGrid>
                <div className="px-4 py-3 border-t border-[#EAEAEA]">
                  <SubHead>Tier mix</SubHead>
                  <div className="flex gap-5 text-[14px] tabular-nums">
                    {[cowork.tierCounts.t1, cowork.tierCounts.t2, cowork.tierCounts.t3].map((n, i) => (
                      <span key={i} className="flex items-center gap-1.5">
                        <span className={`w-2.5 h-2 rounded-full inline-block ${TIER_SWATCH[i]}`} />
                        <span className="font-semibold text-[#0A0A0A]">{n}</span>
                        <span className="text-[13px] text-[#8F8F8F]">T{i + 1}</span>
                      </span>
                    ))}
                  </div>
                </div>
                <SparkBlock label="Cowork events, 8 weeks">
                  <Sparkline
                    data={weekly.coworkEvents.map(p => p.value)}
                    partialLast={weekly.coworkEvents.at(-1)?.partial ?? false}
                    label="Cowork events, weekly"
                  />
                </SparkBlock>
              </>
            )}
          </Panel>

          {/* Code column */}
          <Panel title="Developer Pulse" right={code ? <Tag tone="measured">Measured</Tag> : undefined} flush={code !== null}>
            {code === null ? (
              <Muted>No Claude Code activity for this user yet.</Muted>
            ) : (
              <>
                <FigureGrid cols={2}>
                  {fig('Spend, 7 days', code.spendUsd === null ? '—' : formatCurrency(code.spendUsd), code.spendUsd === null ? 'Unpriced model' : undefined, 'measured')}
                  {fig('Sessions', String(code.sessions), `${code.commits} AI-assisted commits`)}
                </FigureGrid>
                <div className="border-t border-[#EAEAEA]">
                  <FigureGrid cols={2}>
                    {fig('Autonomy', code.autonomy == null ? '—' : `${code.autonomy.toFixed(1)}×`, 'Actions per instruction')}
                    {fig('Engaged time', code.engagedHours == null ? '—' : formatDuration(Math.round(code.engagedHours * 3600)), `${formatTokens(code.linesAdded)} lines added`)}
                  </FigureGrid>
                </div>
                {code.editAcceptRate !== null && (
                  <div className="border-t border-[#EAEAEA]">
                    {fig('Edit acceptance', `${Math.round(code.editAcceptRate * 100)}%`, 'Accepted vs total code-edit suggestions')}
                  </div>
                )}
                <SparkBlock label="Code spend, 8 weeks">
                  <Sparkline
                    data={weekly.codeSpend.map(p => p.value)}
                    partialLast={weekly.codeSpend.at(-1)?.partial ?? false}
                    label="Code spend, weekly"
                  />
                </SparkBlock>
              </>
            )}
          </Panel>
        </div>

        {/* Chat */}
        <Panel title="Chat" flush>
          <Figure
            label="Messages, last 7 days"
            value={chat ? chat.messages7d : <span className="text-[15px] font-medium text-[#8F8F8F] tracking-normal">Not measured</span>}
          />
        </Panel>

      </PageBody>
    </>
  );
}
