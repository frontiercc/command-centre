// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import TopBar from '@/components/layout/TopBar';
import StatCard from '@/components/dashboard/StatCard';
import AdoptionChart from '@/components/dashboard/AdoptionChart';
import StickinessCard from '@/components/dashboard/StickinessCard';
import DepartmentHeatmap from '@/components/dashboard/DepartmentHeatmap';
import TopUsers from '@/components/dashboard/TopUsers';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import AiBriefing from '@/components/dashboard/AiBriefing';
import { DataSourceIndicator } from '@/components/dashboard/DataSourceIndicator';
import Link from 'next/link';
import { PageBody, Toolbar, Strip, Panel, Tag, Notice, B } from '@/components/precision/ui';
import PulseBand from '@/components/pulse/PulseBand';
import CodePulseBand from '@/components/pulse/code/CodePulseBand';
import { useCorePlatformGuard } from '@/components/shared/useCorePlatformGuard';
import GetStartedPanel from '@/components/dashboard/GetStartedPanel';

interface DashboardData {
  stats: {
    activeUsersThisWeek: number;
    activeUsersLastWeek: number;
    eventsLast24h: number;
    openAlertCount: number;
    alertsBySeverity: Record<string, number>;
    coworkSessions: number;
    chatPrompts: number;
    chatFlagged: number;
    coworkFlagged: number;
    codeEvents: number;
    codeFlagged: number;
    avgSessionsPerWeek: { cowork: number; code: number; chat: number };
    otelConfigured: boolean;
  };
  adoptionTrend: Array<{
    date: string;
    surface_chat: number;
    surface_code: number;
    surface_cowork: number;
  }>;
  surfaceBreakdown: { chat: number; code: number; cowork: number };
  departmentBreakdown: Array<{
    department: string;
    user_count: number;
    active_users: number;
    surface_chat: number;
    surface_code: number;
    surface_cowork: number;
  }>;
  topUsers: Array<{
    id: string;
    display_name: string | null;
    email: string;
    department: string | null;
    total_activity: number;
    surface_chat: number;
    surface_code: number;
    surface_cowork: number;
  }>;
  securityMetrics: {
    openAlerts: number;
    resolvedThisWeek: number;
    newThisWeek: number;
    severityCritical: number;
    severityHigh: number;
    severityMedium: number;
    severityLow: number;
    topCategory: string | null;
    topCategoryCount: number;
    topCategoryType: string | null;
  };
  coworkProjects: {
    activeCount: number;
    topProjects: Array<{ project_name: string; session_count: number; user_count: number }>;
  };
  dataSourceStatus: {
    coworkContent: boolean;
    otelCowork: boolean;
    complianceApi: boolean;
    analyticsApi: boolean;
    aiFeatures: boolean;
    mode: 'max' | 'enterprise';
  };
  licensedSeats: number | null;
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatChange(current: number, previous: number): string {
  if (previous === 0) return current > 0 ? '\u2191 new' : '';
  const diff = current - previous;
  const pct = Math.round((diff / previous) * 100);
  if (pct > 0) return `\u2191 ${pct}% vs last week`;
  if (pct < 0) return `\u2193 ${Math.abs(pct)}% vs last week`;
  return 'no change';
}

function formatAlertSeverity(bySeverity: Record<string, number>): string {
  const parts: string[] = [];
  if (bySeverity.critical) parts.push(`${bySeverity.critical} critical`);
  if (bySeverity.high) parts.push(`${bySeverity.high} high`);
  if (bySeverity.medium) parts.push(`${bySeverity.medium} medium`);
  if (bySeverity.low) parts.push(`${bySeverity.low} low`);
  return parts.join(', ') || 'none';
}

export default function DashboardPage() {
  useCorePlatformGuard();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [refreshKey, setRefreshKey] = useState(0);
  const [briefingRefreshKey, setBriefingRefreshKey] = useState(0);
  const [, setTick] = useState(0);
  const [pulseEnabled, setPulseEnabled] = useState(false);

  // Manual Refresh click refreshes both dashboard data AND briefing
  const refreshDashboard = () => {
    setRefreshKey(k => k + 1);
    setBriefingRefreshKey(k => k + 1);
  };

  useEffect(() => {
    fetch('/api/dashboard')
      .then(r => {
        if (!r.ok) throw new Error("Couldn't load this page. Try again.");
        return r.json();
      })
      .then(d => {
        if (d.stats) { setData(d); setLastRefreshed(new Date()); }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [refreshKey]);

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => setPulseEnabled(!!d.pulseEnabled))
      .catch(() => {});
  }, []);


  // Re-render timeago text every 30 seconds
  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (loading) return (
    <>
      <TopBar title="Dashboard" subtitle="How Claude is changing the work across your organisation" />
      <LoadingSpinner />
    </>
  );

  if (!data) return (
    <>
      <TopBar title="Dashboard" subtitle="How Claude is changing the work across your organisation" />
      <PageBody>
        <Notice tone="error">Failed to load dashboard data.</Notice>
      </PageBody>
    </>
  );

  const { stats } = data;

  return (
    <>
      <TopBar title="Dashboard" subtitle="How Claude is changing the work across your organisation" />
      <PageBody>
        {/* Last refreshed + data source status */}
        <Toolbar
          left={
            <span className="flex items-center gap-2">
              <span>Updated {formatTimeAgo(lastRefreshed)}</span>
              <button
                type="button"
                onClick={refreshDashboard}
                className={B.link}
                title="Refresh dashboard"
              >
                Refresh
              </button>
            </span>
          }
        >
          <DataSourceIndicator status={data.dataSourceStatus} />
        </Toolbar>

        {/* Setup steps for a new install (admins only; renders nothing otherwise) */}
        <GetStartedPanel />

        {/* AI intelligence briefing + recommendations: first thing on the page */}
        {!data.dataSourceStatus?.aiFeatures ? (
          <Panel title="Intelligence briefing" badge={<Tag tone="judged">AI summary</Tag>}>
            <PanelEmpty
              title="The briefing needs a Claude API key"
              description="Add one to get a briefing on what changed and what to do next."
              actionLabel="Go to Access & Keys"
              actionHref="/admin/security"
            />
          </Panel>
        ) : (
          <AiBriefing refreshKey={briefingRefreshKey} />
        )}

        {/* Headline figures */}
        <Strip cols={3}>
          <StatCard
            title="Active users"
            value={stats.activeUsersThisWeek}
            change={formatChange(stats.activeUsersThisWeek, stats.activeUsersLastWeek)}
            subtitle={data.licensedSeats != null ? `${stats.activeUsersThisWeek} of ${data.licensedSeats} seats` : 'this week'}
          />
          <StatCard
            title="Events ingested"
            value={stats.eventsLast24h}
            subtitle="last 24 hours"
          />
          <StatCard
            title="Open alerts"
            value={stats.openAlertCount}
            subtitle={formatAlertSeverity(stats.alertsBySeverity)}
          />
        </Strip>
        <Strip cols={3}>
          <StatCard
            title="Cowork sessions"
            value={stats.avgSessionsPerWeek.cowork}
            change="avg / week"
            subtitle={stats.coworkFlagged > 0 ? `${stats.coworkFlagged} flagged for PII` : 'no PII flags'}
            pill={
              data.dataSourceStatus.otelCowork
                ? 'Prompts, skills + connectors'
                : data.dataSourceStatus.coworkContent
                ? 'Messages + tools'
                : undefined
            }
            pillVariant={
              data.dataSourceStatus.otelCowork
                ? 'blue'
                : data.dataSourceStatus.coworkContent
                ? 'green'
                : undefined
            }
            pillTooltip={
              data.dataSourceStatus.otelCowork
                ? 'Cowork data captured via OpenTelemetry integration.'
                : data.dataSourceStatus.coworkContent
                ? 'User messages, MCP connector activity, and skill invocations captured from Claude Code sessions.'
                : 'Cowork conversation content is not available. Tool calls and file access are captured via OpenTelemetry.'
            }
            action={
              !data.dataSourceStatus.otelCowork ? (
                <span>Connect OpenTelemetry for Cowork visibility</span>
              ) : undefined
            }
          />
          <StatCard
            title="Code sessions"
            value={stats.avgSessionsPerWeek.code}
            change="avg / week"
            subtitle={stats.codeFlagged > 0 ? `${stats.codeFlagged} flagged for PII` : 'no PII flags'}
            pill="Prompts, skills + connectors"
            pillVariant="purple"
            pillTooltip="User prompts, MCP connector activity, and skill invocations from Claude Code project sessions."
          />
          <StatCard
            title="Chat conversations"
            value={stats.avgSessionsPerWeek.chat}
            change="avg / week"
            subtitle={stats.chatFlagged > 0 ? `${stats.chatFlagged} flagged for PII` : 'no PII flags'}
            pill="Prompts only"
            pillVariant="blue"
            pillTooltip="Chat prompts captured from Claude Desktop. User input only. Responses are not stored."
          />
        </Strip>

        {/* 14-day adoption trend (2/3) + product stickiness (1/3) */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 min-w-0">
            {data.adoptionTrend.length === 0 ? (
              <Panel title="Adoption trend" className="h-full">
                <PanelEmpty
                  title="No adoption data yet"
                  description="Connect Claude Code or Cowork, or add Anthropic's Compliance or Analytics key, to see adoption trends."
                  actionLabel="Go to Access & Keys"
                  actionHref="/admin/security"
                />
              </Panel>
            ) : (
              <AdoptionChart data={data.adoptionTrend} />
            )}
          </div>
          <StickinessCard />
        </div>

        {/* Department adoption (2/3) + top users this week (1/3) */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 min-w-0">
            {data.departmentBreakdown.length === 0 ? (
              <Panel title="Department breakdown" className="h-full">
                <PanelEmpty
                  title="No department data"
                  description="Set user departments on the User Insights page to see department breakdowns."
                  actionLabel="Go to User Insights"
                  actionHref="/users"
                />
              </Panel>
            ) : (
              <DepartmentHeatmap data={data.departmentBreakdown} />
            )}
          </div>
          <TopUsers users={data.topUsers} />
        </div>

        {/* Work Pulse band with the Developer Pulse strip nested directly below its signal strip */}
        {pulseEnabled ? (
          <PulseBand>
            <CodePulseBand />
          </PulseBand>
        ) : (
          <CodePulseBand />
        )}
      </PageBody>
    </>
  );
}

/** Empty state inside a panel: no second border, a link onward. */
function PanelEmpty({ title, description, actionLabel, actionHref }: {
  title: string; description: string; actionLabel?: string; actionHref?: string;
}) {
  return (
    <div className="py-6 flex flex-col items-center text-center gap-1.5">
      <span className="text-[14px] font-medium text-[#0A0A0A]">{title}</span>
      <span className="text-[13px] text-[#8F8F8F] max-w-xs">{description}</span>
      {actionLabel && actionHref && (
        <Link href={actionHref} className="text-[13px] font-medium text-[#245BF3] hover:underline">{actionLabel}</Link>
      )}
    </div>
  );
}
