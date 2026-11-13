// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useState, type ReactNode } from 'react';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import type { DiscoveredSkill } from '@/lib/pulse/skills-discover';
import Link from 'next/link';
import { PageBody, Panel, Tag, Notice, Muted, B } from '@/components/precision/ui';
import { Frame, Track, linkCls } from '@/components/pulse/WorkPulseOverview';
import { isWebUrl } from '@/lib/library/source-url';
import { WORK_PULSE_VENDOR_LABELS } from '@/lib/dashboard/vendor';

function formatSkillName(name: string): string {
  return name.replace(':', ' · ');
}

function formatConnectorName(name: string): string {
  return name.replace(/^mcp__/, '').replace(/_/g, ' ');
}

type RowVendor = 'claude' | 'openai';

/** The name, with a Claude, ChatGPT or Codex tag once both vendors appear on the page. */
function toolLabel(name: string, vendor: RowVendor | undefined, showVendor: boolean, tag?: string): ReactNode {
  if (!showVendor || !vendor) return name;
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      <span className="truncate">{name}</span>
      <Tag tone="neutral">{tag ?? WORK_PULSE_VENDOR_LABELS[vendor]}</Tag>
    </span>
  );
}


function GapList({
  title,
  subtitle,
  items,
  nameKey,
  emptyMessage,
  formatName,
  showVendor,
}: {
  title: string;
  subtitle: string;
  items: Array<{ usage_count: number; user_count: number; vendor?: RowVendor; tag?: string; [k: string]: unknown }>;
  nameKey: string;
  emptyMessage: string;
  formatName: (n: string) => string;
  showVendor: boolean;
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
              <li key={`${name}|${item.tag ?? item.vendor ?? ''}`} className="px-4 py-2 border-t border-[#F2F2F2] first:border-t-0 flex items-center justify-between gap-3">
                <span className="text-[14px] text-[#0A0A0A] truncate">{toolLabel(formatName(name), item.vendor, showVendor, item.tag)}</span>
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
                <span className="text-[14px] font-medium text-[#0A0A0A] group-hover:text-[#1F6F8B] truncate">
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

/* ── What is spreading, what is stuck, what nobody uses ─────────── */

const kindWord = (k: string) => (k === 'connector' ? 'connector' : 'skill');
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const dateOf = (s: number) => new Date(s * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function Spreading({ rows }: { rows: SpreadRow[] }) {
  const [kind, setKind] = useState<'skill' | 'connector'>('skill');
  const shown = rows.filter(r => r.kind === kind).slice(0, 10);
  const grew = [...shown].filter(r => r.people > r.before).sort((a, b) => (b.people - b.before) - (a.people - a.before))[0];
  const fresh = shown.filter(r => r.isNew).length;
  const max = Math.max(1, ...shown.map(r => r.people));
  const label = kind === 'skill' ? 'skills' : 'connectors';
  const freshWords = fresh === 0 ? '' : fresh === 1 ? ' One was used for the first time this month.' : ` ${fresh} were used for the first time this month.`;
  return (
    <Frame
      title="What is spreading"
      period={
        <span className="inline-flex items-center gap-2">
          <span>Last 30 days against the 30 before</span>
          <span className="inline-flex border border-[#EAEAEA] rounded-[8px] overflow-hidden bg-white">
            {(['skill', 'connector'] as const).map(k => (
              <button key={k} type="button" onClick={() => setKind(k)} className={`text-[12px] px-2 py-0.5 ${k === kind ? 'bg-[#F2F2F2] text-[#0A0A0A] font-medium' : 'bg-white text-[#666666]'}`}>
                {k === 'skill' ? 'Skills' : 'Connectors'}
              </button>
            ))}
          </span>
        </span>
      }
      answer={shown.length === 0
        ? <>No {label} were used in the last 30 days.</>
        : grew
          ? <><b>{grew.name}</b> reached the most new people: {grew.people}, up from {grew.before}.{freshWords}</>
          : <>No {label} reached more people than the month before.{freshWords}</>}
      note="Bars count the people using each one, not how often it was used, so one that is spreading stands out."
    >
      {shown.map(r => {
        const change = r.people > r.before ? `up ${r.people - r.before}` : r.people === r.before ? 'same' : `down ${r.before - r.people}`;
        return (
          <div key={`${r.kind}:${r.name}`} className="grid grid-cols-[minmax(0,200px)_minmax(0,1fr)_132px] gap-2.5 items-center py-[3px] text-[13px]">
            <span className="truncate text-[#333333]">
              {r.name}
              {r.isNew && <span className="ml-1.5 text-[10px] bg-[#EEF5F8] text-[#1F6F8B] rounded-[3px] px-1.5 py-px align-middle">New</span>}
            </span>
            <Track value={r.people / max} />
            <span className="text-right tabular-nums" style={{ color: r.people > r.before ? '#1A7F37' : '#777777' }}>
              {plural(r.people, 'person', 'people')} · {change}
            </span>
          </div>
        );
      })}
    </Frame>
  );
}

function Stuck({ rows }: { rows: SoleRow[] }) {
  return (
    <Frame
      title="Stuck with one person"
      period="Last 30 days"
      answer={rows.length === 0
        ? <>Nothing: every skill and connector used this month was used by more than one person.</>
        : <><b>{rows.length === 1 ? 'One skill or connector is' : `${rows.length} skills and connectors are`}</b> used by one person only. If they left, that work stops.</>}
      note="Pairing someone with them is the fix. The same rule as the department page."
    >
      {rows.map(r => (
        <div key={`${r.kind}:${r.name}`} className="flex items-baseline gap-2.5 py-1.5 border-b border-[#F2F2F2] last:border-b-0 text-[13px]">
          <span className="min-w-0 truncate text-[#0A0A0A]">{r.name}</span>
          <span className="text-[#777777] whitespace-nowrap">{kindWord(r.kind)} · only {r.who ?? 'one person'}{r.department ? ` · ${r.department}` : ''}</span>
          <span className="ml-auto tabular-nums text-[#333333] whitespace-nowrap">{plural(r.uses, 'use', 'uses')}</span>
        </div>
      ))}
    </Frame>
  );
}

function Unused({ rows, of }: { rows: UnusedRow[]; of: number }) {
  if (of === 0) return null;
  return (
    <Frame
      title="Used by nobody"
      period="Last 30 days"
      answer={rows.length === 0
        ? <>Every one of the {of} skills and connectors on the Board was used this month.</>
        : <><b>{rows.length} of {of}</b> skills and connectors on the Board were not used at all.</>}
      note={<>Worth retiring, or worth a nudge. <Link href="/library" className={linkCls}>Open the S&amp;C Board</Link></>}
    >
      {rows.slice(0, 10).map(r => (
        <div key={r.id} className="flex items-baseline gap-2.5 py-1.5 border-b border-[#F2F2F2] last:border-b-0 text-[13px]">
          <Link href={`/library/${r.id}`} className="min-w-0 truncate text-[#0A0A0A] hover:text-[#1F6F8B]">{r.name}</Link>
          <span className="text-[#777777] whitespace-nowrap">{kindWord(r.kind)}{r.claimed ? ` · claimed${r.author ? ` by ${r.author}` : ''}` : ' · unclaimed'}</span>
          <span className="ml-auto text-[#8F8F8F] whitespace-nowrap">{r.lastUsed === null ? 'never used' : `last used ${dateOf(r.lastUsed)}`}</span>
        </div>
      ))}
      {rows.length > 10 && <p className="m-0 mt-1.5 text-[13px] text-[#8F8F8F]">and {rows.length - 10} more.</p>}
    </Frame>
  );
}

export interface SpreadRow { kind: 'skill' | 'connector'; name: string; tag: string; people: number; before: number; uses: number; isNew: boolean }
export interface SoleRow { kind: 'skill' | 'connector'; name: string; tag: string; uses: number; who: string | null; department: string | null }
export interface UnusedRow { id: number; name: string; kind: string; author: string | null; claimed: boolean; lastUsed: number | null }

interface OverviewData {
  spread?: SpreadRow[];
  sole?: SoleRow[];
  unused?: UnusedRow[];
  unusedOf?: number;
  topSkills: Array<{ skill_name: string; vendor?: RowVendor; tag?: string; usage_count: number; user_count: number }>;
  topConnectors: Array<{ mcp_server: string; vendor?: RowVendor; tag?: string; usage_count: number; user_count: number }>;
  skillGap: Array<{ skill_name: string; vendor?: RowVendor; tag?: string; usage_count: number; user_count: number }>;
  connectorGap: Array<{ mcp_server: string; vendor?: RowVendor; tag?: string; usage_count: number; user_count: number }>;
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
      <TopBar title="Tool usage" subtitle="Which skills and connectors are spreading, and which are stuck" />
      <LoadingSpinner />
    </>
  );

  if (overviewError) return (
    <>
      <TopBar title="Tool usage" subtitle="Which skills and connectors are spreading, and which are stuck" />
      <PageBody>
        <Notice tone="error" title="Failed to load.">{overviewError}</Notice>
      </PageBody>
    </>
  );

  // Tag each row Claude or OpenAI once OpenAI tools appear on the page.
  const showVendor = [...(overview?.topSkills ?? []), ...(overview?.topConnectors ?? [])].some(i => i.vendor === 'openai');

  return (
    <>
      <TopBar title="Tool usage" subtitle="Which skills and connectors are spreading, and which are stuck" />
      <PageBody className="dash-compact">

        {/* 1. What is spreading */}
        <Spreading rows={overview?.spread ?? []} />

        {/* 2 and 3 */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <Stuck rows={overview?.sole ?? []} />
          <Unused rows={overview?.unused ?? []} of={overview?.unusedOf ?? 0} />
        </div>

        {/* 4. What colleagues use that you don't */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <GapList
            title="Skills you haven't tried"
            subtitle="Used by colleagues in the last 30 days, not yet in your history"
            items={overview?.skillGap ?? []}
            nameKey="skill_name"
            emptyMessage="You've used every skill your colleagues use."
            formatName={formatSkillName}
            showVendor={showVendor}
          />
          <GapList
            title="Connectors you haven't tried"
            subtitle="Used by colleagues in the last 30 days, not yet in your history"
            items={overview?.connectorGap ?? []}
            nameKey="mcp_server"
            emptyMessage="You've used every connector your colleagues use."
            formatName={formatConnectorName}
            showVendor={showVendor}
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
