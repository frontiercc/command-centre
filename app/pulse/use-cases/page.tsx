// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import {
  PageBody, Toolbar, Panel, PanelFoot, Strip, Figure, T, Tag, Pill, Notice, Empty, Spark, cx,
} from '@/components/precision/ui';

interface GovernanceBet {
  id: string;
  title: string;
  ownerDisplayName: string | null;
  departments: string[];
  lifecycle: string;
  weeksInLifecycle: number | null;
  measured: { distinctUsers: number; sessions: number; hours: number | null };
  estimated: { hoursRecovered: number };
  series: Array<number | null>;
}

interface GovernanceWorkflow {
  id: string;
  title: string;
  lifecycle: string;
  series: Array<number | null>;
  measuredHours: number | null;
  distinctUsers: number;
}

interface GovernanceRollup {
  window: { weeks: number; endsWeekStart: number; label: string };
  headline: { declared: number; adopted: number; piloting: number; atRisk: number; notSeen: number };
  value: {
    hoursRecovered: number;
    dollarsRecovered: number;
    isEstimate: true;
    calibration: { minutesPerSession: number; loadedCompAnnual: number; workingHoursPerYear: number };
  };
  narrative: string;
  bets: GovernanceBet[];
  allWorkflows: GovernanceWorkflow[];
  allWorkflowsTotal: number;
}

const LIFECYCLE_ORDER = ['adopted', 'piloting', 'at_risk', 'not_seen'] as const;

const LIFECYCLE_LABEL: Record<string, string> = {
  adopted: 'Adopted',
  piloting: 'Piloting',
  at_risk: 'At risk',
  not_seen: 'Not seen',
};

const LIFECYCLE_TONE: Record<string, 'good' | 'info' | 'warn' | 'neutral'> = {
  adopted: 'good',
  piloting: 'info',
  at_risk: 'warn',
  not_seen: 'neutral',
};

function formatCurrency(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function fmtHours(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

function LifecyclePill({ lifecycle }: { lifecycle: string }) {
  return <Pill tone={LIFECYCLE_TONE[lifecycle] ?? 'neutral'}>{LIFECYCLE_LABEL[lifecycle] ?? lifecycle}</Pill>;
}

function GroupRow({ lifecycle, count, colSpan }: { lifecycle: string; count: number; colSpan: number }) {
  return (
    <tr className="border-t border-[#F2F2F2] bg-[#FAFAFA]">
      <td colSpan={colSpan} className="px-4 py-1.5 text-[13px] font-medium text-[#666666]">
        {LIFECYCLE_LABEL[lifecycle] ?? lifecycle} <span className="tabular-nums text-[#8F8F8F]">{count}</span>
      </td>
    </tr>
  );
}

function BetsPanel({ bets, minutesPerSession }: { bets: GovernanceBet[]; minutesPerSession: number }) {
  const groups = LIFECYCLE_ORDER
    .map(lifecycle => ({ lifecycle, bets: bets.filter(b => b.lifecycle === lifecycle) }))
    .filter(g => g.bets.length > 0);
  return (
    <Panel
      title="Strategic bets"
      subtitle={<span className="tabular-nums">{bets.length}</span>}
      right={<><Tag tone="measured">Measured</Tag><Tag tone="judged">Estimate</Tag></>}
      flush
    >
      <div className="overflow-x-auto">
        <table className={T.table}>
          <thead>
            <tr className={T.headRow}>
              <th scope="col" className={T.th}>Bet</th>
              <th scope="col" className={T.th}>Lifecycle</th>
              <th scope="col" className={T.th}>13-week trend</th>
              <th scope="col" className={T.thRight}>Sessions · users</th>
              <th scope="col" className={T.thRight}>Measured hours</th>
              <th scope="col" className={T.thRight}>Hours recovered (estimate)</th>
            </tr>
          </thead>
          {groups.map(group => (
            <tbody key={group.lifecycle}>
              <GroupRow lifecycle={group.lifecycle} count={group.bets.length} colSpan={6} />
              {group.bets.map(bet => {
                const lifecycleLabel = LIFECYCLE_LABEL[bet.lifecycle] ?? bet.lifecycle;
                return (
                  <tr key={bet.id} className={T.row}>
                    <td className={cx(T.td, 'min-w-[220px]')}>
                      <Link href={`/use-cases/${encodeURIComponent(bet.id)}`} className="font-semibold text-[#0A0A0A] hover:underline">
                        {bet.title}
                      </Link>
                      <div className="text-[13px] text-[#8F8F8F] mt-0.5">
                        Owner: {bet.ownerDisplayName ?? 'Unassigned'}
                        {bet.departments.length > 0 && <> · {bet.departments.join(', ')}</>}
                      </div>
                    </td>
                    <td className={T.td}>
                      <LifecyclePill lifecycle={bet.lifecycle} />
                      <div className="text-[13px] text-[#8F8F8F] mt-1 whitespace-nowrap">
                        in {lifecycleLabel.toLowerCase()}{bet.weeksInLifecycle !== null ? ` for ${bet.weeksInLifecycle} ${bet.weeksInLifecycle === 1 ? 'week' : 'weeks'}` : ''}
                      </div>
                    </td>
                    <td className={T.td}>
                      <span role="img" aria-label={`${bet.title} weekly sessions`}><Spark data={bet.series} width={96} /></span>
                    </td>
                    <td className={cx(T.tdRight, 'text-[#05073F] whitespace-nowrap')}>
                      {bet.measured.sessions} {bet.measured.sessions === 1 ? 'session' : 'sessions'} · {bet.measured.distinctUsers} {bet.measured.distinctUsers === 1 ? 'user' : 'users'}
                    </td>
                    <td className={cx(T.tdRight, 'whitespace-nowrap')}>
                      {bet.measured.hours != null
                        ? <span className="text-[#05073F]">{fmtHours(bet.measured.hours)} h</span>
                        : <span className="text-[#8F8F8F]">Not measured</span>}
                    </td>
                    <td className={cx(T.tdRight, 'whitespace-nowrap text-[#2451F3]')}>
                      ≈ {fmtHours(bet.estimated.hoursRecovered)} hrs
                      <div className="text-[13px]">est. {minutesPerSession} min × {bet.measured.sessions} sessions</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>
    </Panel>
  );
}

function WorkflowsByLifecycle({ workflows, total }: { workflows: GovernanceWorkflow[]; total: number }) {
  if (workflows.length === 0) return null;
  const groups = LIFECYCLE_ORDER
    .map(lifecycle => ({ lifecycle, workflows: workflows.filter(wf => wf.lifecycle === lifecycle) }))
    .filter(g => g.workflows.length > 0);
  return (
    <Panel
      title="Other confirmed use cases"
      subtitle="Everything confirmed that is not marked as a strategic bet, grouped by lifecycle"
      right={<Tag tone="measured">Measured</Tag>}
      flush
    >
      <div className="overflow-x-auto">
        <table className={T.table}>
          <thead>
            <tr className={T.headRow}>
              <th scope="col" className={T.th}>Title</th>
              <th scope="col" className={T.th}>Lifecycle</th>
              <th scope="col" className={T.th}>13-week trend</th>
              <th scope="col" className={T.thRight}>Measured hours</th>
              <th scope="col" className={T.thRight}>Users</th>
            </tr>
          </thead>
          {groups.map(group => (
            <tbody key={group.lifecycle}>
              <GroupRow lifecycle={group.lifecycle} count={group.workflows.length} colSpan={5} />
              {group.workflows.map(wf => (
                <tr key={wf.id} className={T.row}>
                  <td className={cx(T.td, 'max-w-[280px]')}>
                    <Link href={`/use-cases/${encodeURIComponent(wf.id)}`} className="font-medium text-[#0A0A0A] hover:underline truncate block">
                      {wf.title}
                    </Link>
                  </td>
                  <td className={T.td}><LifecyclePill lifecycle={wf.lifecycle} /></td>
                  <td className={T.td}>
                    <span role="img" aria-label={`${wf.title} weekly sessions`}><Spark data={wf.series} width={96} /></span>
                  </td>
                  <td className={cx(T.tdRight, 'whitespace-nowrap')}>
                    {wf.measuredHours != null ? (
                      <span className="text-[#05073F]">{fmtHours(wf.measuredHours)} h</span>
                    ) : (
                      <span className="text-[#8F8F8F]">Not measured</span>
                    )}
                  </td>
                  <td className={T.tdRight}>{wf.distinctUsers}</td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
      {total > workflows.length && (
        <PanelFoot>
          Showing the top {workflows.length} of {total} confirmed use cases.
        </PanelFoot>
      )}
    </Panel>
  );
}

export default function UseCaseGovernancePage() {
  const [data, setData] = useState<GovernanceRollup | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notEnabled, setNotEnabled] = useState(false);

  useEffect(() => {
    fetch('/api/use-cases/governance')
      .then(r => {
        if (r.status === 404) { setNotEnabled(true); throw new Error('not enabled'); }
        if (!r.ok) throw new Error("Couldn't load this page. Try again.");
        return r.json();
      })
      .then(setData)
      .catch(e => { if (e.message !== 'not enabled') setError(e.message); })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return (
    <>
      <TopBar title="Use Case Governance" subtitle="Declared strategic bets and their measured outcomes" />
      <LoadingSpinner />
    </>
  );

  if (notEnabled) return (
    <>
      <TopBar title="Use Case Governance" subtitle="Declared strategic bets and their measured outcomes" />
      <PageBody>
        <Empty title="Use Cases is not enabled on this instance">
          An admin can enable it under Admin → Use Cases.
        </Empty>
      </PageBody>
    </>
  );

  if (error) return (
    <>
      <TopBar title="Use Case Governance" subtitle="Declared strategic bets and their measured outcomes" />
      <PageBody>
        <Notice tone="error">Failed to load: {error}</Notice>
      </PageBody>
    </>
  );

  if (!data) return null;

  if (data.bets.length === 0) {
    return (
      <>
        <TopBar title="Use Case Governance" subtitle="Declared strategic bets and their measured outcomes" />
        <PageBody>
          <Empty title="No strategic bets yet.">
            Mark a use case as a board-level bet on the{' '}
            <Link href="/use-cases" className="text-[#05073F] hover:underline">
              Use Cases register
            </Link>.
          </Empty>
          <WorkflowsByLifecycle workflows={data.allWorkflows} total={data.allWorkflowsTotal} />
        </PageBody>
      </>
    );
  }

  const { headline, value, window: win } = data;
  const totalSessions = data.bets.reduce((acc, b) => acc + b.measured.sessions, 0);

  return (
    <>
      <TopBar title="Use Case Governance" subtitle="Declared strategic bets and their measured outcomes" />
      <PageBody>
        <Toolbar left={win.label} />

        <Strip cols={5}>
          <Figure label="Declared bets" value={headline.declared.toLocaleString()} />
          <Figure label="Adopted" value={headline.adopted.toLocaleString()} />
          <Figure label="Piloting" value={headline.piloting.toLocaleString()} />
          <Figure
            label="At risk"
            value={headline.atRisk.toLocaleString()}
            sub={headline.notSeen > 0 ? `${headline.notSeen} not seen` : undefined}
          />
          <Figure
            label={<span className="inline-flex items-center gap-1.5">Value recovered <Tag tone="judged">Estimate</Tag></span>}
            value={<>≈ {formatCurrency(value.dollarsRecovered)}</>}
            tone="judged"
            sub={`~${fmtHours(value.hoursRecovered)} hrs · est. ${value.calibration.minutesPerSession} min × ${totalSessions} sessions · loaded @ ${formatCurrency(value.calibration.loadedCompAnnual)}/yr`}
          />
        </Strip>

        {/* Narrative */}
        <Panel title="Summary">
          <p className="m-0 text-[14px] leading-6 text-[#333333]">{data.narrative}</p>
        </Panel>

        <BetsPanel bets={data.bets} minutesPerSession={value.calibration.minutesPerSession} />

        <WorkflowsByLifecycle workflows={data.allWorkflows} total={data.allWorkflowsTotal} />
      </PageBody>
    </>
  );
}
