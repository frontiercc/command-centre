// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState } from 'react';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import type { DiscoveredSkill } from '@/lib/pulse/skills-discover';
import { PageBody, Panel, BarRow, Tag, Notice, Muted, B } from '@/components/precision/ui';
import { isWebUrl } from '@/lib/library/source-url';

function formatSkillName(name: string): string {
  return name.replace(':', ' · ');
}

function formatConnectorName(name: string): string {
  return name.replace(/^mcp__/, '').replace(/_/g, ' ');
}

function RankedList({
  title,
  items,
  nameKey,
  emptyMessage,
  formatName,
}: {
  title: string;
  items: Array<{ usage_count: number; user_count: number; [k: string]: unknown }>;
  nameKey: string;
  emptyMessage: string;
  formatName: (n: string) => string;
}) {
  const max = items[0]?.usage_count ?? 1;
  return (
    <Panel title={title} subtitle="Org, 30 days" right={<Tag tone="measured">Measured</Tag>} flush={items.length > 0}>
      {items.length === 0 ? (
        <Muted>{emptyMessage}</Muted>
      ) : (
        <div className="py-1">
          {items.map((item, i) => {
            const name = item[nameKey] as string;
            const barPct = Math.round((item.usage_count / max) * 100);
            return (
              <BarRow
                key={name}
                rank={i + 1}
                label={formatName(name)}
                value={`${item.usage_count}× · ${item.user_count} ${item.user_count === 1 ? 'user' : 'users'}`}
                pct={barPct}
                tone="measured"
              />
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function GapList({
  title,
  subtitle,
  items,
  nameKey,
  emptyMessage,
  formatName,
}: {
  title: string;
  subtitle: string;
  items: Array<{ usage_count: number; user_count: number; [k: string]: unknown }>;
  nameKey: string;
  emptyMessage: string;
  formatName: (n: string) => string;
}) {
  return (
    <Panel title={title} subtitle={subtitle} flush={items.length > 0}>
      {items.length === 0 ? (
        <Muted>{emptyMessage}</Muted>
      ) : (
        <ul className="m-0 p-0 list-none">
          {items.map(item => {
            const name = item[nameKey] as string;
            return (
              <li key={name} className="px-4 py-2 border-t border-[#F2F2F2] first:border-t-0 flex items-center justify-between gap-3">
                <span className="text-[14px] text-[#0A0A0A] truncate">{formatName(name)}</span>
                <span className="text-[13px] text-[#666666] tabular-nums shrink-0">
                  {item.user_count} {item.user_count === 1 ? 'teammate' : 'teammates'} use this
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

const CATEGORY_LABELS: Record<string, string> = {
  skill: 'Skill',
  connector: 'Connector',
  official: 'Official',
};

function DiscoverFeed({
  items,
  cached_at,
  is_stale,
  loading,
  refreshing,
  error,
  onRefresh,
}: {
  items: DiscoveredSkill[];
  cached_at: string | null;
  is_stale: boolean;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  function fmtAge(iso: string): string {
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (days === 0) return 'Updated today';
    if (days === 1) return 'Updated yesterday';
    return `Updated ${days} days ago`;
  }

  return (
    <Panel
      title="Discover new skills & connectors"
      subtitle={cached_at ? `${fmtAge(cached_at)}${is_stale ? ' · cache is stale' : ''}` : undefined}
      right={
        <button type="button" onClick={onRefresh} disabled={refreshing} className={B.secondary}>
          {refreshing ? 'Searching…' : 'Refresh'}
        </button>
      }
    >
      {loading ? (
        <Muted>Loading…</Muted>
      ) : error ? (
        <Notice tone="error">{error}</Notice>
      ) : items.length === 0 ? (
        <Muted>
          No results cached yet. Click Refresh to search Anthropic, the web, and GitHub for new skills and connectors.
        </Muted>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {items.map((item, i) => (
            <a
              key={i}
              href={isWebUrl(item.source_url) ? item.source_url : undefined}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex flex-col gap-1.5 border border-[#EAEAEA] rounded-[14px] px-3.5 py-3 hover:border-[#DADADA] hover:bg-[#FAFAFA] hover:no-underline"
            >
              <span className="flex items-start justify-between gap-2">
                <span className="text-[14px] font-medium text-[#0A0A0A] group-hover:text-[#245BF3] truncate">
                  {item.name}
                </span>
                <span className="shrink-0">
                  <Tag tone={item.category === 'official' ? 'measured' : 'neutral'}>{CATEGORY_LABELS[item.category] ?? item.category}</Tag>
                </span>
              </span>
              <span className="text-[13px] text-[#666666] leading-5">{item.description}</span>
              {item.published_at && (
                <span className="text-[12px] text-[#8F8F8F] tabular-nums">{item.published_at}</span>
              )}
            </a>
          ))}
        </div>
      )}
    </Panel>
  );
}

interface OverviewData {
  topSkills: Array<{ skill_name: string; usage_count: number; user_count: number }>;
  topConnectors: Array<{ mcp_server: string; usage_count: number; user_count: number }>;
  skillGap: Array<{ skill_name: string; usage_count: number; user_count: number }>;
  connectorGap: Array<{ mcp_server: string; usage_count: number; user_count: number }>;
}

interface DiscoverData {
  items: DiscoveredSkill[];
  cached_at: string | null;
  is_stale: boolean;
}

export default function SkillsPage() {
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  const [discover, setDiscover] = useState<DiscoverData>({ items: [], cached_at: null, is_stale: true });
  const [discoverLoading, setDiscoverLoading] = useState(true);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    fetch('/api/pulse/skills-overview')
      .then(r => { if (!r.ok) throw new Error("Couldn't load this page. Try again."); return r.json(); })
      .then(setOverview)
      .catch(e => setOverviewError(e.message))
      .finally(() => setOverviewLoading(false));

    fetch('/api/pulse/skills-discover')
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(setDiscover)
      .catch(() => {})
      .finally(() => setDiscoverLoading(false));
  }, []);

  async function handleRefresh() {
    setRefreshing(true);
    setDiscoverError(null);
    try {
      const r = await fetch('/api/pulse/skills-discover', { method: 'POST' });
      if (!r.ok) throw new Error("Couldn't refresh. Try again.");
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      setDiscover(data);
    } catch (e) {
      setDiscoverError(e instanceof Error ? e.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }

  if (overviewLoading) return (
    <>
      <TopBar title="Tool usage" subtitle="Adoption, gaps, and ecosystem discovery" />
      <LoadingSpinner />
    </>
  );

  if (overviewError) return (
    <>
      <TopBar title="Tool usage" subtitle="Adoption, gaps, and ecosystem discovery" />
      <PageBody>
        <Notice tone="error" title="Failed to load.">{overviewError}</Notice>
      </PageBody>
    </>
  );

  return (
    <>
      <TopBar title="Tool usage" subtitle="Adoption, gaps, and ecosystem discovery" />
      <PageBody>

        {/* Row 1 — Org top usage */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <RankedList
            title="Top skills"
            items={overview?.topSkills ?? []}
            nameKey="skill_name"
            emptyMessage="No skill invocations captured yet."
            formatName={formatSkillName}
          />
          <RankedList
            title="Top connectors"
            items={overview?.topConnectors ?? []}
            nameKey="mcp_server"
            emptyMessage="No connector invocations captured yet."
            formatName={formatConnectorName}
          />
        </div>

        {/* Row 2 — Gap / discovery */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <GapList
            title="Skills you haven't tried"
            subtitle="Used by teammates in the last 30 days, not yet in your history"
            items={overview?.skillGap ?? []}
            nameKey="skill_name"
            emptyMessage="You've used all the top skills your org uses. Nice."
            formatName={formatSkillName}
          />
          <GapList
            title="Connectors you haven't tried"
            subtitle="Connected by teammates in the last 30 days, not yet in your history"
            items={overview?.connectorGap ?? []}
            nameKey="mcp_server"
            emptyMessage="You've used all the top connectors your org uses."
            formatName={formatConnectorName}
          />
        </div>

        {/* Row 3 — External discovery feed */}
        <DiscoverFeed
          items={discover.items}
          cached_at={discover.cached_at}
          is_stale={discover.is_stale}
          loading={discoverLoading}
          refreshing={refreshing}
          error={discoverError}
          onRefresh={handleRefresh}
        />

      </PageBody>
    </>
  );
}
