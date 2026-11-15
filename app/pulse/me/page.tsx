// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import type { FrontierView } from '@/lib/pulse/frontier-view';
import type { MyPeriod, PulsePeriod } from '@/lib/pulse/period-shape';
import { withTierNames, type TierNames } from '@/lib/pulse/tier-names';
import FrontierHero from '@/components/pulse/FrontierHero';
import GenerateBriefingButton from '@/components/pulse/GenerateBriefingButton';
import { cleanTitle } from '@/components/pulse/CapabilityLog';
import { Frame } from '@/components/pulse/WorkPulseOverview';
import { WorkPanel, TaskList, DeeperPanel, ByHandPanel, ProducedPanel, ColleagueToolsPanel, SpendPanel, type ByHand, type MonthSpend, type Who, type DrillKind } from '@/components/pulse/MyPulsePanels';
import { PageBody, Toolbar, Notice, Dot, B, C } from '@/components/precision/ui';
import { useVendor, useOpenAiOnly, VendorSwitch } from '@/components/shared/VendorSwitch';
import { WORK_PULSE_VENDOR_LABELS } from '@/lib/dashboard/vendor';
import { UNLINKED_TITLE } from '@/lib/pulse/unlinked';

interface PersonalPulseData {
  humanTime?: ByHand | null;
  period?: MyPeriod | null;
  tierNames?: TierNames | null;
  spendThisMonth?: MonthSpend | null;
  canSeeSpendReview?: boolean;
  userId: string | null;
  displayName: string | null;
  department: string | null;
  metrics: {
    oti: number | null;
    dds: number | null;
    psr: number | null;
    ors: number | null;
    oti_early_read?: number | null;
    metric_version?: number | null;
  } | null;
  priorMetrics: {
    oti: number | null;
    dds: number | null;
    psr: number | null;
    ors: number | null;
  } | null;
  frontier: FrontierView | null;
  frontierAccess?: { canReview: boolean; canOpenUseCases: boolean };
  weeklyPulse: { body: string; suggestion: string | null; generated_at: number } | null;
  teamId: string | null;
  capabilitiesDetail: {
    count: number;
    confirmed: Array<{ title: string; detected_at: number; confirmed_at: number | null; tier: number | null }>;
    pending: Array<{ id: number; title: string; body: string | null; tier: number | null; detected_at: number }>;
  } | null;
  teamMetrics: { ors: number | null } | null;
  coworkFrictionIndex?: number | null;
  otiUnderReview?: boolean;
  openaiPresent?: boolean;
}

const TITLE = 'My Pulse';
const SUBTITLE = 'How your work with Claude is going, and what to try next';

export default function PersonalPulsePage() {
  const searchParams = useSearchParams();
  const viewingUserId = searchParams.get('userId');

  const [data, setData] = useState<PersonalPulseData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // One period for the page: this week, this month or this quarter.
  const [period, setPeriod] = useState<PulsePeriod>('quarter');
  const [drill, setDrill] = useState<DrillKind | null>(null);
  const [pulseStartAt, setPulseStartAt] = useState<number | null>(null);
  // The All / Claude / OpenAI switch, shared with the dashboard and Executive View.
  const [vendor, setVendor, vendorReady] = useVendor();
  const openaiOnly = useOpenAiOnly();

  useEffect(() => {
    if (!vendorReady) return; // the saved view is read after the page loads
    setLoading(true);
    setError(null);
    const meUrl = viewingUserId
      ? `/api/pulse/me?userId=${encodeURIComponent(viewingUserId)}&vendor=${vendor}&period=${period}`
      : `/api/pulse/me?vendor=${vendor}&period=${period}`;
    Promise.all([
      fetch(meUrl).then(r => { if (!r.ok) throw new Error("Couldn't load this page. Try again."); return r.json(); }),
      fetch('/api/pulse/user-prefs').then(r => r.ok ? r.json() : { pulse_start_at: null }),
    ])
      .then(([meData, prefs]) => {
        setData(meData);
        setPulseStartAt(prefs.pulse_start_at ?? null);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [refreshKey, viewingUserId, vendor, vendorReady, period]);

  if (loading) return (
    <>
      <TopBar title={TITLE} subtitle={SUBTITLE} />
      <LoadingSpinner />
    </>
  );

  if (error) return (
    <>
      <TopBar title={TITLE} subtitle={SUBTITLE} />
      <PageBody>
        <Notice tone="error" title="Failed to load.">{error}</Notice>
      </PageBody>
    </>
  );

  if (!data) return null;

  async function handleCapabilityAction(id: number, action: 'confirm' | 'dismiss') {
    await fetch('/api/pulse/capabilities', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action }),
    });
    setRefreshKey(k => k + 1);
  }

  const pending = data.capabilitiesDetail?.pending ?? [];
  const product = vendor === 'openai' ? 'ChatGPT' : vendor === 'claude' || !data.openaiPresent ? 'Claude' : 'Claude and ChatGPT';
  const who: Who = { you: !viewingUserId, name: data.displayName ?? 'This person' };
  const reviewHref = data.canSeeSpendReview && data.userId ? `/finops/spend-review/${encodeURIComponent(data.userId)}` : null;
  const q = data.period ?? null;

  return (
    <>
      <TopBar title={TITLE} subtitle={SUBTITLE} />
      <PageBody className="dash-compact">

        {(pulseStartAt || reviewHref || data.openaiPresent || vendor !== 'all') && (
          <Toolbar
            left={pulseStartAt ? (
              <Dot color={C.good}>
                Active since {new Date(pulseStartAt * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
              </Dot>
            ) : undefined}
          >
            {reviewHref && (
              <Link href={reviewHref} className={B.link}>{viewingUserId ? 'Spend review' : 'Your spend review'}</Link>
            )}
            <VendorSwitch vendor={vendor} onChange={setVendor} openaiPresent={data.openaiPresent ?? false} labels={WORK_PULSE_VENDOR_LABELS} />
          </Toolbar>
        )}
        {vendor !== 'all' && !openaiOnly && (
          <p className="m-0 -mt-2 text-[13px] text-[#8F8F8F]">
            Showing {WORK_PULSE_VENDOR_LABELS[vendor]} only{vendor === 'openai' ? ': ChatGPT Chat and ChatGPT Work' : ': Claude Chat, Claude Cowork and Claude in Office/Google'}.
          </p>
        )}

        {q ? (
          <>
            {/* 1. Your work, over the chosen period */}
            <WorkPanel
              q={q}
              product={product}
              who={who}
              period={period}
              onPeriod={setPeriod}
              onDrill={setDrill}
              drill={drill}
              reviewHref={pending.length > 0 ? '#to-review' : null}
              names={data.tierNames ?? undefined}
            />

            {/* The work behind whichever figure was clicked */}
            {drill && (
              <TaskList kind={drill} period={period} userId={viewingUserId} who={who} onClose={() => setDrill(null)} names={data.tierNames ?? undefined} vendor={vendor} tool={product === 'Claude and ChatGPT' ? 'AI' : product} />
            )}

            {/* 2. Best work this week, with what it actually was */}
            <FrontierHero view={data.frontier} canOpenUseCases={data.frontierAccess?.canOpenUseCases ?? false} names={data.tierNames ?? undefined} />

            {/* 3. Is the work getting deeper? Six weeks as a grid, then the longer views */}
            <DeeperPanel q={q} who={who} names={data.tierNames ?? undefined} />

            {/* 4. By hand vs with Claude */}
            <ByHandPanel h={data.humanTime} who={who} onSeeSessions={() => setDrill('humantime')} tool={product === 'Claude and ChatGPT' ? 'AI' : product} surface="cowork" />

            {/* 4 and 5 */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
              <ProducedPanel q={q} who={who} period={period} />
              <ColleagueToolsPanel q={q} who={who} department={data.department} period={period} />
            </div>

            {/* 6 */}
            {data.spendThisMonth && <SpendPanel s={data.spendThisMonth} product={product} who={who} reviewHref={reviewHref} />}
          </>
        ) : (
          // Not matched to anyone's activity yet: say how it gets linked. Matched, but no work: say so.
          !data.userId && who.you
            ? <Notice tone="info" title={UNLINKED_TITLE} />
            : <Notice tone="info" title="No work yet.">Nothing has been recorded for {who.you ? 'you' : 'this person'} yet.</Notice>
        )}

        {/* 6. The week, in a paragraph */}
        <Frame
          title={who.you ? 'Your week, in a paragraph' : 'Their week, in a paragraph'}
          tag="AI summary"
          period={
            <span className="inline-flex items-center gap-2">
              {data.weeklyPulse && new Date(data.weeklyPulse.generated_at * 1000).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
              {data.userId && <GenerateBriefingButton type="user" userId={data.userId} own={!viewingUserId} onComplete={() => setRefreshKey(k => k + 1)} />}
            </span>
          }
        >
          {data.weeklyPulse ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-2 text-[14px] leading-[22px] text-[#1A1A1A]">
              <div>{data.weeklyPulse.body.split(/\n\s*\n/).filter(t => t.trim()).map((t, i) => <p key={i} className="m-0 mb-2 last:mb-0">{t}</p>)}</div>
              {data.weeklyPulse.suggestion && <p className="m-0"><b className="font-semibold">Suggestion for next week:</b> {data.weeklyPulse.suggestion}</p>}
            </div>
          ) : (
            // "Generate now" is mentioned only when its button is shown: the sign-in is matched to a person.
            <p className="m-0 mt-2 text-[13px] text-[#8F8F8F]">No paragraph yet. It is written each Sunday{data.userId ? ', or use Generate now' : ''}.</p>
          )}
        </Frame>

        {/* New ways of working waiting for review */}
        {pending.length > 0 && (
          <Frame id="to-review" title="Waiting for review" period={`${pending.length} new ${pending.length === 1 ? 'way' : 'ways'} of working`}
            answer={<>Claude thinks {who.you ? 'you' : 'they'} may have started {pending.length === 1 ? 'a new way of working' : 'new ways of working'}. Confirm to track {pending.length === 1 ? 'it' : 'them'}.</>}>
            {pending.map(c => (
              <div key={c.id} className="flex items-start gap-3 py-2 border-b border-[#F2F2F2] last:border-b-0">
                <div className="flex-1 min-w-0">
                  <p className="m-0 text-[13px] font-medium text-[#0A0A0A]">{cleanTitle(c.title)}</p>
                  {c.body && <p className="m-0 mt-0.5 text-[12px] text-[#8F8F8F] line-clamp-1">{withTierNames(c.body, data.tierNames)}</p>}
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <button type="button" onClick={() => handleCapabilityAction(c.id, 'confirm')} className={`${B.secondary} !py-0.5 !px-2 !text-[12px]`}>Confirm</button>
                  <button type="button" onClick={() => handleCapabilityAction(c.id, 'dismiss')} className={`${B.secondary} !py-0.5 !px-2 !text-[12px]`}>Dismiss</button>
                </div>
              </div>
            ))}
          </Frame>
        )}

      </PageBody>
    </>
  );
}
