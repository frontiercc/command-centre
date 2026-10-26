// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0
// Some icon drawings in this file are from Feather (MIT); see THIRD-PARTY-NOTICES.md.

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import TopBar from '@/components/layout/TopBar';
import { PageBody, cx } from '@/components/precision/ui';

// --- Types ---

interface DbStats {
  fileSizeBytes: number;
}

interface ConfigData {
  dpiaCompleted?: string | boolean;
  dpiaDate?: string;
  dataProtectionOfficer?: string;
  aiActRiskTier?: string;
  aiActTransparencyNotice?: string | boolean;
  isoControlOwner?: string;
  isoCertificationStatus?: string;
  organisationName?: string;
}

// --- Helpers ---

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / 1024).toFixed(1) + ' KB';
}

function countComplianceFields(config: ConfigData): number {
  let count = 0;
  if (config.dpiaCompleted === true || config.dpiaCompleted === 'true') count++;
  if (config.dpiaDate) count++;
  if (config.dataProtectionOfficer) count++;
  if (config.aiActRiskTier && config.aiActRiskTier !== 'not-assessed') count++;
  if (config.aiActTransparencyNotice === true || config.aiActTransparencyNotice === 'true') count++;
  if (config.isoControlOwner) count++;
  if (config.isoCertificationStatus && config.isoCertificationStatus !== 'not-started') count++;
  return count;
}

// --- Sub-components ---

interface TileProps {
  href: string;
  title: string;
  icon: React.ReactNode;
  value: React.ReactNode;
  valueClassName?: string;
  caption?: React.ReactNode;
  children?: React.ReactNode;
}

/** A linked status tile: 12px grey title, 24px figure, 12px caption. */
function Tile({ href, title, icon, value, valueClassName, caption, children }: TileProps) {
  return (
    <Link
      href={href}
      className="block h-full bg-white border border-[#EAEAEA] rounded-[14px] p-4 hover:border-[#DADADA] hover:bg-[#FAFAFA] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#245BF3]/30"
    >
      <div className="flex flex-col gap-1.5 min-w-0">
        <span className="flex items-center gap-2 text-[13px] text-[#666666]">
          <span className="shrink-0 text-[#8F8F8F]">{icon}</span>
          {title}
        </span>
        <span className={cx('text-[24px] leading-7 font-semibold tracking-[-0.02em] tabular-nums', valueClassName ?? 'text-[#0A0A0A]')}>
          {value}
        </span>
        {caption && <span className="text-[13px] text-[#8F8F8F]">{caption}</span>}
        {children}
      </div>
    </Link>
  );
}

// --- Icons (inline SVG line icons, no external deps) ---

function TileIcon({ children }: { children: React.ReactNode }) {
  return (
    <svg aria-hidden="true" width={16} height={16} className="block" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

const IconUsers = () => (
  <TileIcon>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </TileIcon>
);

const IconDatabase = () => (
  <TileIcon>
    <ellipse cx="12" cy="5" rx="9" ry="3" />
    <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
    <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
  </TileIcon>
);

const IconBell = () => (
  <TileIcon>
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </TileIcon>
);

const IconActivity = () => (
  <TileIcon>
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
  </TileIcon>
);

const IconCloud = () => (
  <TileIcon>
    <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
  </TileIcon>
);

const IconShield = () => (
  <TileIcon>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </TileIcon>
);

// --- Main page ---

export default function AdminOverviewPage() {
  const [userCount, setUserCount] = useState<number | null>(null);
  const [dbStats, setDbStats] = useState<DbStats | null>(null);
  const [alertCount, setAlertCount] = useState<number | null>(null);
  const [eventsLast24h, setEventsLast24h] = useState<number | null>(null);
  const [archiveEnabled, setArchiveEnabled] = useState<boolean | null>(null);
  const [complianceScore, setComplianceScore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/users').then(r => r.json()).catch(() => []),
      fetch('/api/db/stats').then(r => r.json()).catch(() => null),
      fetch('/api/alerts?status=open').then(r => r.json()).catch(() => []),
      fetch('/api/dashboard').then(r => r.json()).catch(() => null),
      fetch('/api/archive/config').then(r => r.json()).catch(() => null),
      fetch('/api/config').then(r => r.json()).catch(() => null),
    ]).then(([usersData, stats, alertsData, dashData, archData, configData]) => {
      setUserCount(Array.isArray(usersData) ? usersData.length : 0);
      setDbStats(stats);
      setAlertCount(Array.isArray(alertsData) ? alertsData.length : 0);
      setEventsLast24h(dashData?.stats?.eventsLast24h ?? null);
      setArchiveEnabled(archData?.archiveEnabled ?? null);
      setComplianceScore(configData ? countComplianceFields(configData) : null);
    }).finally(() => setLoading(false));
  }, []);

  return (
    <>
      <TopBar title="Overview" subtitle="System health at a glance" />
      <PageBody>
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" aria-busy="true">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="bg-white border border-[#EAEAEA] rounded-[14px] p-4 h-[104px] flex flex-col gap-2.5">
                <div className="h-2.5 w-2/5 rounded-[6px] bg-[#F2F2F2]" />
                <div className="h-[22px] w-1/4 rounded-[6px] bg-[#F2F2F2]" />
                <div className="h-2 w-3/4 rounded-[6px] bg-[#F7F7F7]" />
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">

            {/* 1. Users */}
            <Tile href="/admin/users" title="User Insights" icon={<IconUsers />} value={userCount ?? '—'} caption="total users" />

            {/* 2. Database */}
            <Tile
              href="/admin/system"
              title="Database"
              icon={<IconDatabase />}
              value={dbStats ? formatBytes(dbStats.fileSizeBytes) : '—'}
              caption="database size"
            />

            {/* 3. Open Alerts */}
            <Tile
              href="/alerts"
              title="Open alerts"
              icon={<IconBell />}
              value={alertCount ?? '—'}
              valueClassName={alertCount != null && alertCount > 0 ? 'text-[#B42318]' : undefined}
              caption={alertCount === 1 ? 'open alert' : 'open alerts'}
            />

            {/* 4. Events (last 24h) */}
            <Tile href="/audit" title="Events" icon={<IconActivity />} value={eventsLast24h ?? '—'} caption="in last 24 hours" />

            {/* 5. Archive */}
            <Tile
              href="/admin/data"
              title="Archive"
              icon={<IconCloud />}
              value={archiveEnabled === true ? 'Enabled' : archiveEnabled === false ? 'Disabled' : '—'}
              valueClassName={archiveEnabled === true ? 'text-[#1A7F37]' : archiveEnabled === false ? 'text-[#8F8F8F]' : undefined}
              caption="archive status"
            />

            {/* 6. Compliance */}
            <Tile
              href="/admin/compliance"
              title="Compliance"
              icon={<IconShield />}
              value={complianceScore !== null ? `${complianceScore}/7` : '—'}
              valueClassName={
                complianceScore === null
                  ? undefined
                  : complianceScore === 7
                    ? 'text-[#1A7F37]'
                    : complianceScore >= 4
                      ? 'text-[#B54708]'
                      : 'text-[#B42318]'
              }
              caption={complianceScore !== null ? 'declarations complete' : undefined}
            />

          </div>
        )}
      </PageBody>
    </>
  );
}
