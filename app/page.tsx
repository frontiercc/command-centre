// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { PageBody, Toolbar, Notice, B } from '@/components/precision/ui';
import { useVendor, VendorSwitch } from '@/components/shared/VendorSwitch';
import type { Vendor, VendorSplit, ProductCounts, ProductId } from '@/lib/dashboard/vendor';
import { useCorePlatformGuard } from '@/components/shared/useCorePlatformGuard';
import GetStartedPanel from '@/components/dashboard/GetStartedPanel';
import ThisWeek from '@/components/dashboard/ThisWeek';
import WhoIsUsing from '@/components/dashboard/WhoIsUsing';
import AlertsDecision from '@/components/dashboard/AlertsDecision';

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
    /** cowork is the Work box: Claude Cowork and ChatGPT Work. */
    avgSessionsPerWeek: { cowork: number; code: number; chat: number };
    otelConfigured: boolean;
  };
  vendor: Vendor;
  openaiPresent: boolean;
  products: {
    sessions: Record<'chat' | 'work' | 'code', VendorSplit>;
    flagged: Record<'chat' | 'work' | 'code', VendorSplit>;
    activeUsers: { claude: number; openai: number };
  };
  adoptionTrend: Array<{ date: string; products: ProductCounts }>;
  surfaceBreakdown: { chat: number; code: number; cowork: number };
  departmentBreakdown: Array<{
    department: string;
    user_count: number;
    active_users: number;
    products: ProductCounts;
  }>;
  topUsers: Array<{
    id: string;
    display_name: string | null;
    email: string;
    department: string | null;
    total_activity: number;
    products: ProductCounts;
  }>;
  /** Product ids the charts show, in display order. */
  productsShown: ProductId[];
  /** Claude in Office and Google shown: Claude Cowork reads "Claude Cowork and apps". */
  officeShown?: boolean;
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
    openai?: boolean;
    mode: 'max' | 'enterprise';
  };
  licensedSeats: number | null;
  weeklyActive: Array<{ endS: number; people: number }>;
  adoptionTargetPct: number | null;
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export default function DashboardPage() {
  useCorePlatformGuard();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [refreshKey, setRefreshKey] = useState(0);
  const [, setTick] = useState(0);
  // The vendor switch, remembered per browser and shared with Work Pulse.
  const [vendor, setVendor, vendorReady] = useVendor();

  const refreshDashboard = () => setRefreshKey(k => k + 1);

  useEffect(() => {
    if (!vendorReady) return; // the saved view is read after the page loads
    fetch(`/api/dashboard?vendor=${vendor}`)
      .then(r => {
        // A role without the dashboard is refused here and sent to its own
        // Pulse page by useCorePlatformGuard; that is not an error to log.
        if (r.status === 403) return null;
        if (!r.ok) throw new Error("Couldn't load this page. Try again.");
        return r.json();
      })
      .then(d => {
        if (d?.stats) { setData(d); setLastRefreshed(new Date()); }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [refreshKey, vendor, vendorReady]);



  // Re-render timeago text every 30 seconds
  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (loading) return (
    <>
      <TopBar title="Dashboard" subtitle="How AI is changing the work across your organisation" />
      <LoadingSpinner />
    </>
  );

  if (!data) return (
    <>
      <TopBar title="Dashboard" subtitle="How AI is changing the work across your organisation" />
      <PageBody>
        <Notice tone="error">Failed to load dashboard data.</Notice>
      </PageBody>
    </>
  );

  return (
    <>
      <TopBar title="Dashboard" subtitle="How AI is changing the work across your organisation" />
      <PageBody>
        <Toolbar
          left={
            <span className="flex items-center gap-2">
              <span>Updated {formatTimeAgo(lastRefreshed)}</span>
              <button type="button" onClick={refreshDashboard} className={B.link} title="Refresh dashboard">Refresh</button>
            </span>
          }
        >
          <VendorSwitch vendor={vendor} onChange={setVendor} openaiPresent={data.openaiPresent} />
        </Toolbar>

        {/* Setup steps for a new install (admins only; renders nothing otherwise) */}
        <GetStartedPanel />

        {/* One answer from each page, each linking to its page (the page is the figure's one home). */}
        <ThisWeek key={`tw-${refreshKey}-${vendor}`} vendor={vendor} openaiPresent={data.openaiPresent} />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          <WhoIsUsing
            weeklyActive={data.weeklyActive}
            departments={data.departmentBreakdown}
            targetPct={data.adoptionTargetPct}
            vendor={vendor}
            openaiPresent={data.openaiPresent}
          />
          <AlertsDecision key={`al-${refreshKey}`} />
        </div>
      </PageBody>
    </>
  );
}

