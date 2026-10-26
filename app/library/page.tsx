// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0
// Some icon drawings in this file are from Heroicons (MIT); see THIRD-PARTY-NOTICES.md.

'use client';

import { useEffect, useState, useCallback, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import {
  PageBody, Toolbar, Panel, PanelFoot, Strip, Figure, Bar, T, Tag, B, Chip, Notice, Muted, cx,
} from '@/components/precision/ui';

interface LibraryEntry {
  id: number;
  name: string;
  type: 'skill' | 'connector';
  surface: string;
  source: string;
  description: string | null;
  install_guide: string | null;
  source_url: string | null;
  author_name: string | null;
  is_published: number;
  invocation_count: number;
  user_count: number;
  vote_count: number;
  user_voted: number;
  week_count: number;
  trend_pct: number;
  reads?: number;
  writes?: number;
}

function readWriteLine(e: { reads?: number; writes?: number }): string | null {
  const parts: string[] = [];
  if (e.reads)  parts.push(`${e.reads} reads`);
  if (e.writes) parts.push(`${e.writes} writes`);
  return parts.length ? parts.join(' · ') : null;
}

interface LeaderboardUser {
  user_id: string;
  display_name: string | null;
  skill_count: number;
  connector_count: number;
  total_count: number;
  top_skills: string[];
  top_connectors: string[];
}

interface UserRank {
  rank: number;
  total_count: number;
  skill_count: number;
  connector_count: number;
}

interface SkillToTry {
  id: number;
  name: string;
  type: string;
  description: string | null;
  install_guide: string | null;
  invocation_count: number;
  user_count: number;
}

interface RecentEntry {
  id: number;
  name: string;
  type: string;
  description: string | null;
  install_guide: string | null;
  author_name: string | null;
  updated_at: number;
}

interface DeptRow {
  department: string;
  user_count: number;
  skill_uses: number;
  connector_uses: number;
  total_uses: number;
}

interface DeptPick {
  id: number;
  name: string;
  type: string;
  description: string | null;
  install_guide: string | null;
  invocation_count: number;
  user_count: number;
}

interface LibraryData {
  entries: LibraryEntry[];
  total: number;
  unclaimed_count: number;
  stats: { skill_count: number; connector_count: number; invocations_this_week: number; new_this_week: number };
  capability: { claimed: number; total: number };
  leaderboard: LeaderboardUser[];
  user_rank: UserRank | null;
  skills_to_try: SkillToTry[];
  recent_entries: RecentEntry[];
  dept_breakdown: DeptRow[];
  user_dept: string | null;
  dept_picks: DeptPick[];
}

function fmt(name: string) {
  return name.replace(/^mcp__/, '').replace(/^anthropic-skills:/, '').replace(/_/g, ' ').replace(':', ' · ');
}

function initials(name: string | null) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2 ? `${parts[0][0]}${parts[1][0]}`.toUpperCase() : name.slice(0, 2).toUpperCase();
}

/** Small outline button used on list rows (Install, upvote, Claim). */
const SMALL_BTN = cx(B.secondary, '!px-2 !py-0.5');
const VOTED_BTN = '!border-[#245BF3] !text-[#245BF3] !bg-[#F2F5FF]';

/** Line icon (24px grid, currentColor stroke): a single path via `d`, or shapes as children. */
function LineIcon({ d, size = 14, className, children }: { d?: string; size?: 12 | 14; className?: string; children?: ReactNode }) {
  return (
    <svg aria-hidden="true" width={size} height={size} className={cx('shrink-0', className)} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      {d ? <path d={d} /> : children}
    </svg>
  );
}

const ICON = {
  plus: 'M12 4.5v15m7.5-7.5h-15',
  download: 'M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3',
  prev: 'M15.75 19.5L8.25 12l7.5-7.5',
  next: 'M8.25 4.5l7.5 7.5-7.5 7.5',
  flag: 'M3 3v1.5M3 21v-6m0 0l2.77-.693a9 9 0 016.208.682l.108.054a9 9 0 006.086.71l3.114-.732a48.524 48.524 0 01-.005-10.499l-3.11.732a9 9 0 01-6.085-.711l-.108-.054a9 9 0 00-6.208-.682L3 4.5M3 15V4.5',
};

function UpIcon() {
  return (
    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
    </svg>
  );
}

function VoteButton({ voted, count, onClick }: { voted: boolean; count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={voted}
      aria-label={voted ? `Remove upvote (${count})` : `Upvote (${count})`}
      className={cx(SMALL_BTN, voted && VOTED_BTN)}
    >
      <UpIcon />
      <span className="tabular-nums">{count}</span>
    </button>
  );
}

function InstallButton({ eligible, open, onToggle }: { eligible: boolean; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      title={eligible ? 'Install this skill' : 'Install guide needed'}
      className={cx(SMALL_BTN, !eligible && '!text-[#8F8F8F]')}
    >
      <LineIcon d={ICON.download} size={12} />
      Install
    </button>
  );
}

/**
 * Underline tabs that sit in a panel header and span its full width
 * (the kit's Tabs draw their own rule, which would sit inside the padding).
 */
function PanelTabs<K extends string>({ tabs, value, onChange, label, right }: {
  tabs: Array<{ value: K; label: ReactNode }>;
  value: K;
  onChange: (v: K) => void;
  label: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-4 border-b border-[#EAEAEA]">
      <div role="tablist" aria-label={label} className="flex gap-5 overflow-x-auto -mb-px min-w-0">
        {tabs.map(t => {
          const on = t.value === value;
          return (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => onChange(t.value)}
              className={cx('text-[14px] py-2.5 border-b-2 whitespace-nowrap',
                on ? 'border-[#0A0A0A] text-[#0A0A0A] font-medium' : 'border-transparent text-[#666666] hover:text-[#0A0A0A]')}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {right && <div className="ml-auto shrink-0 text-[13px] text-[#8F8F8F]">{right}</div>}
    </div>
  );
}

// ── Headline strip ────────────────────────────────────────────────────────────

function HeadlineStrip({ data }: { data: LibraryData }) {
  const ur = data.user_rank;
  const nextRankEntry = ur && ur.rank > 1
    ? data.leaderboard[ur.rank - 2]
    : null;
  const gapToNext = nextRankEntry ? nextRankEntry.total_count - ur!.total_count : 0;
  const { claimed, total } = data.capability;
  const pct = total > 0 ? Math.round((claimed / total) * 100) : 0;

  return (
    <Strip cols={5}>
      <div className="p-4 flex flex-col gap-1.5 min-w-0">
        <span className="text-[13px] text-[#666666]">Claimed</span>
        <span className="text-[24px] leading-7 font-semibold tracking-[-0.02em] tabular-nums text-[#0A0A0A]">{pct}%</span>
        <Bar pct={pct} tone="measured" height={4} />
        <span className="text-[13px] text-[#8F8F8F] tabular-nums">{claimed} of {total} have an owner</span>
      </div>
      <Figure
        label="Skill uses this week"
        value={data.stats.invocations_this_week.toLocaleString()}
        sub={`${data.stats.new_this_week} new to the board this week`}
      />
      <Figure label="Organisation skills" value={data.stats.skill_count.toLocaleString()} />
      <Figure label="Connectors" value={data.stats.connector_count.toLocaleString()} />
      {ur ? (
        <Figure
          label="Your standing"
          value={`#${ur.rank}`}
          sub={
            <>
              <span className="tabular-nums">{ur.total_count.toLocaleString()} uses</span>
              {gapToNext > 0 && <span className="tabular-nums text-[#B54708]"> · {gapToNext} behind #{ur.rank - 1}</span>}
              <span className="block tabular-nums">{ur.skill_count} skill · {ur.connector_count} connector</span>
            </>
          }
        />
      ) : (
        <Figure label="Your standing" value="—" sub="Start using skills in Claude to earn your rank." />
      )}
    </Strip>
  );
}

// ── Highlights (was the Live Strip carousel) ──────────────────────────────────

interface StripCard {
  id: number;
  name: string;
  type: string;
  description: string | null;
  install_guide?: string | null;
  badge: string;
  badgeTone: 'measured' | 'warn';
  meta: string;
}

function HighlightCard({ card }: { card: StripCard }) {
  return (
    <Link
      href={`/library/${card.id}`}
      className="flex flex-col gap-1.5 px-3.5 py-3 border border-[#EAEAEA] rounded-[14px] text-[#0A0A0A] hover:border-[#DADADA] hover:bg-[#FAFAFA] min-w-0 h-full"
    >
      <span className="flex items-center gap-2 min-w-0">
        <span className="font-mono text-[13px] font-semibold truncate">{fmt(card.name)}</span>
        <span className={cx('ml-auto text-[12px] font-medium tabular-nums whitespace-nowrap shrink-0',
          card.badgeTone === 'warn' ? 'text-[#B54708]' : 'text-[#245BF3]')}>
          {card.badge}
        </span>
      </span>
      {card.description && (
        <span className="text-[14px] leading-5 text-[#4D4D4D] line-clamp-2">{card.description}</span>
      )}
      <span className="text-[13px] text-[#8F8F8F] tabular-nums">{card.meta}</span>
    </Link>
  );
}

type SlideKey = 'hot' | 'new' | 'voted' | 'unclaimed' | 'dept';

/** Line icons for the highlight tabs (the old carousel's slide emoji). */
const SLIDE_ICON: Record<SlideKey, ReactNode> = {
  hot: <LineIcon d="M15.362 5.214A8.252 8.252 0 0112 21 8.25 8.25 0 016.038 7.048 8.287 8.287 0 009 9.6a8.983 8.983 0 013.361-6.867 8.21 8.21 0 003 2.48zM12 18a3.75 3.75 0 00.495-7.467 5.99 5.99 0 00-1.925 3.546 5.974 5.974 0 01-2.133-1A3.75 3.75 0 0012 18z" className="text-[#8F8F8F]" />,
  new: <LineIcon d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" className="text-[#8F8F8F]" />,
  voted: <LineIcon d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" className="text-[#8F8F8F]" />,
  unclaimed: <LineIcon d={ICON.flag} className="text-[#8F8F8F]" />,
  dept: (
    <LineIcon className="text-[#8F8F8F]">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1" />
    </LineIcon>
  ),
};

function Highlights({ entries, recentEntries, deptPicks, userDept }: {
  entries: LibraryEntry[];
  recentEntries: RecentEntry[];
  deptPicks: DeptPick[];
  userDept: string | null;
}) {
  const [slideKey, setSlideKey] = useState<SlideKey | null>(null);
  const [paused, setPaused] = useState(false);

  const hot: StripCard[] = entries
    .filter(e => e.week_count >= 3 && e.source === 'org' && e.is_published === 1)
    .sort((a, b) => b.trend_pct - a.trend_pct)
    .slice(0, 3)
    .map(e => ({
      id: e.id, name: e.name, type: e.type, description: e.description, install_guide: e.install_guide,
      badge: `+${e.trend_pct}%`, badgeTone: 'measured',
      meta: `${e.week_count} uses this week · ${e.user_count} ${e.user_count === 1 ? 'user' : 'users'}`,
    }));

  const newCards: StripCard[] = recentEntries.slice(0, 3).map(e => ({
    id: e.id, name: e.name, type: e.type, description: e.description, install_guide: e.install_guide,
    badge: 'New', badgeTone: 'measured',
    meta: e.author_name ? `Claimed by ${e.author_name}` : 'Recently added',
  }));

  const topVoted: StripCard[] = entries
    .filter(e => e.vote_count > 0 && e.is_published === 1)
    .sort((a, b) => b.vote_count - a.vote_count)
    .slice(0, 3)
    .map(e => ({
      id: e.id, name: e.name, type: e.type, description: e.description, install_guide: e.install_guide,
      badge: `${e.vote_count} ${e.vote_count === 1 ? 'vote' : 'votes'}`, badgeTone: 'measured',
      meta: `${e.invocation_count} total uses · ${e.user_count} ${e.user_count === 1 ? 'user' : 'users'}`,
    }));

  const unclaimed: StripCard[] = entries
    .filter(e => e.is_published === 0 && e.source === 'org')
    .sort((a, b) => b.invocation_count - a.invocation_count)
    .slice(0, 3)
    .map(e => ({
      id: e.id, name: e.name, type: e.type, description: e.description, install_guide: null,
      badge: 'No owner', badgeTone: 'warn',
      meta: `${e.invocation_count} uses · nobody has claimed this yet`,
    }));

  const deptCards: StripCard[] = deptPicks.slice(0, 3).map(e => ({
    id: e.id, name: e.name, type: e.type, description: e.description, install_guide: e.install_guide,
    badge: `${e.invocation_count}×`, badgeTone: 'measured',
    meta: `${e.user_count} ${e.user_count === 1 ? 'teammate' : 'teammates'} in ${userDept ?? 'your department'}`,
  }));

  const slides: Array<{ key: SlideKey; label: string; cards: StripCard[] }> = [
    { key: 'hot' as const,       label: 'Hot this week',    cards: hot },
    { key: 'new' as const,       label: 'New to the board', cards: newCards },
    { key: 'voted' as const,     label: 'Top voted',        cards: topVoted },
    { key: 'unclaimed' as const, label: 'Unclaimed',        cards: unclaimed },
    { key: 'dept' as const,      label: `${userDept ?? 'Your department'} picks`, cards: deptCards },
  ].filter(s => s.cards.length > 0);

  const keys = slides.map(s => s.key).join(',');

  // Auto-advance every 5 seconds; hovering the panel pauses it.
  useEffect(() => {
    if (paused || slides.length < 2) return;
    const order = keys.split(',') as SlideKey[];
    const t = setInterval(() => {
      setSlideKey(k => {
        const i = k ? order.indexOf(k) : 0;
        return order[(Math.max(i, 0) + 1) % order.length];
      });
    }, 5000);
    return () => clearInterval(t);
  }, [paused, slides.length, keys]);

  if (!slides.length) return null;

  const cur = slides.find(s => s.key === slideKey) ?? slides[0];

  return (
    <section
      className="bg-white border border-[#EAEAEA] rounded-[14px] min-w-0"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <PanelTabs
        label="Highlights"
        tabs={slides.map(s => ({
          value: s.key,
          label: <span className="inline-flex items-center gap-1.5">{SLIDE_ICON[s.key]}{s.label}</span>,
        }))}
        value={cur.key}
        onChange={setSlideKey}
      />
      <div role="tabpanel" className="grid grid-cols-1 md:grid-cols-3 gap-3 p-4">
        {cur.cards.map(card => <HighlightCard key={card.id} card={card} />)}
      </div>
    </section>
  );
}

// ── Skills / connectors list ──────────────────────────────────────────────────

const TAB_PAGE_SIZE = 10;

function TabbedTopList({
  skills,
  connectors,
  skillTotal,
  connectorTotal,
  onVote,
}: {
  skills: LibraryEntry[];
  connectors: LibraryEntry[];
  skillTotal: number;
  connectorTotal: number;
  onVote: (id: number) => void;
}) {
  const [tab, setTab] = useState<'skills' | 'connectors'>('skills');
  const [skillPage, setSkillPage] = useState(0);
  const [connectorPage, setConnectorPage] = useState(0);
  const [openId, setOpenId] = useState<number | null>(null);

  const allEntries = tab === 'skills' ? skills : connectors;
  const page = tab === 'skills' ? skillPage : connectorPage;
  const setPage = tab === 'skills' ? setSkillPage : setConnectorPage;
  const totalPages = Math.ceil(allEntries.length / TAB_PAGE_SIZE);
  const entries = allEntries.slice(page * TAB_PAGE_SIZE, (page + 1) * TAB_PAGE_SIZE);
  const globalOffset = page * TAB_PAGE_SIZE;
  const max = (tab === 'skills' ? skills : connectors)[0]?.invocation_count ?? 1;

  return (
    <section className="bg-white border border-[#EAEAEA] rounded-[14px] min-w-0" onClick={() => setOpenId(null)}>
      <PanelTabs
        label="Skills and connectors"
        tabs={[
          { value: 'skills' as const, label: <>Skills <span className="tabular-nums text-[#8F8F8F]">{skillTotal}</span></> },
          { value: 'connectors' as const, label: <>Connectors <span className="tabular-nums text-[#8F8F8F]">{connectorTotal}</span></> },
        ]}
        value={tab}
        onChange={t => { setTab(t); setOpenId(null); }}
        right="All time · organisation"
      />

      {allEntries.length === 0 ? (
        <div className="p-4"><Muted>No {tab} logged yet.</Muted></div>
      ) : (
        <div className="overflow-x-auto">
          <table className={T.table}>
            <tbody>
              {entries.map((e, i) => {
                const barPct = Math.round((e.invocation_count / max) * 100);
                const rw = e.type === 'connector' ? readWriteLine(e) : null;
                const eligible = e.is_published === 1 && !!e.install_guide;
                return (
                  <tr key={e.id} className={cx(T.row, 'first:border-t-0')} onClick={ev => ev.stopPropagation()}>
                    <td className="pl-4 pr-1 py-2.5 align-top w-6 text-[#8F8F8F] tabular-nums">{globalOffset + i + 1}</td>
                    <td className="px-2 py-2.5 align-top min-w-0">
                      <div className="flex items-center gap-2 flex-wrap min-w-0">
                        <Link href={`/library/${e.id}`} className="font-mono text-[13px] font-medium text-[#0A0A0A] hover:underline break-all">
                          {fmt(e.name)}
                        </Link>
                        {e.author_name && <span className="text-[13px] text-[#666666]">by {e.author_name}</span>}
                        {e.is_published === 0 && (
                          <Link
                            href={`/library/submit?name=${encodeURIComponent(e.name)}&type=${e.type}`}
                            className="text-[13px] font-medium text-[#B54708] hover:underline"
                          >
                            Unclaimed
                          </Link>
                        )}
                      </div>
                      {e.description && <div className="text-[#666666] mt-0.5 line-clamp-2">{e.description}</div>}
                      {rw && <div className="text-[13px] text-[#8F8F8F] mt-0.5 tabular-nums">{rw}</div>}
                      <div className="mt-1.5 max-w-[360px]"><Bar pct={barPct} tone="measured" /></div>
                    </td>
                    <td className="px-2 py-2.5 align-top text-right whitespace-nowrap tabular-nums">
                      <div className="font-medium">{e.invocation_count}×</div>
                      <div className="text-[13px] text-[#8F8F8F]">{e.user_count} {e.user_count === 1 ? 'user' : 'users'}</div>
                    </td>
                    <td className="pl-2 pr-4 py-2.5 align-top text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        <div className="relative">
                          <InstallButton
                            eligible={eligible}
                            open={openId === e.id}
                            onToggle={() => setOpenId(openId === e.id ? null : e.id)}
                          />
                          {openId === e.id && (
                            <InstallPanel entry={e} align="right" onClose={() => setOpenId(null)} />
                          )}
                        </div>
                        <VoteButton voted={!!e.user_voted} count={e.vote_count} onClick={() => onVote(e.id)} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {totalPages > 1 && (
        <div className="px-4 py-2.5 border-t border-[#F2F2F2] flex items-center gap-3 text-[13px] text-[#666666]">
          <span className="tabular-nums">{page + 1} of {totalPages} · {allEntries.length} total</span>
          <span className="ml-auto flex items-center gap-3">
            <button
              type="button"
              onClick={() => { setPage(p => Math.max(0, p - 1)); setOpenId(null); }}
              disabled={page === 0}
              className={cx(B.link, 'inline-flex items-center gap-1 disabled:cursor-not-allowed disabled:text-[#B3B3B3] disabled:no-underline')}
            >
              <LineIcon d={ICON.prev} />
              Previous
            </button>
            <button
              type="button"
              onClick={() => { setPage(p => Math.min(totalPages - 1, p + 1)); setOpenId(null); }}
              disabled={page >= totalPages - 1}
              className={cx(B.link, 'inline-flex items-center gap-1 disabled:cursor-not-allowed disabled:text-[#B3B3B3] disabled:no-underline')}
            >
              Next
              <LineIcon d={ICON.next} />
            </button>
          </span>
        </div>
      )}
    </section>
  );
}

// ── Leaderboard ───────────────────────────────────────────────────────────────

function LeaderboardSidebar({
  users,
  userRank,
}: {
  users: LeaderboardUser[];
  userRank: UserRank | null;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  if (!users.length) return null;
  return (
    <Panel title="Leaderboard" subtitle="Skill and connector uses, all time" flush>
      {users.map((u, i) => {
        const isYou = userRank && u.total_count === userRank.total_count && u.skill_count === userRank.skill_count;
        const isHovered = hoveredId === u.user_id;
        const hasDetails = u.top_skills.length > 0 || u.top_connectors.length > 0;
        return (
          <div
            key={u.user_id}
            className={cx('flex items-center gap-2.5 px-4 py-2 border-t border-[#F2F2F2] first:border-t-0', isYou && 'bg-[#F5F8FF]')}
          >
            <span className="w-6 shrink-0 text-[#8F8F8F] tabular-nums">#{i + 1}</span>
            <span className="w-6 h-6 rounded-full bg-[#F2F2F2] text-[11px] font-semibold text-[#4D4D4D] inline-flex items-center justify-center shrink-0">
              {initials(u.display_name)}
            </span>
            <span className="flex flex-col min-w-0 flex-1 relative">
              <span
                className={cx('truncate cursor-default font-medium', isYou ? 'text-[#245BF3]' : 'text-[#0A0A0A]',
                  hasDetails && 'underline decoration-dotted underline-offset-2 decoration-[#B3B3B3]')}
                onMouseEnter={() => hasDetails && setHoveredId(u.user_id)}
                onMouseLeave={() => setHoveredId(null)}
              >
                {u.display_name ?? 'Unknown'}{isYou ? ' (you)' : ''}
              </span>
              {isHovered && hasDetails && (
                <div
                  className="absolute bottom-full left-0 mb-2 z-50 w-56 bg-white rounded-[14px] border border-[#EAEAEA] shadow-[0_4px_16px_rgba(0,0,0,0.08)] p-3 pointer-events-none flex flex-col gap-2"
                  onMouseEnter={() => setHoveredId(u.user_id)}
                  onMouseLeave={() => setHoveredId(null)}
                >
                  <span className="text-[13px] font-semibold text-[#0A0A0A]">{u.display_name ?? 'Unknown'}</span>
                  {u.top_skills.length > 0 && (
                    <div>
                      <p className="m-0 mb-1 text-[12px] text-[#666666]">Skills</p>
                      <div className="flex flex-wrap gap-1">
                        {u.top_skills.map(s => <Tag key={s}>{s}</Tag>)}
                      </div>
                    </div>
                  )}
                  {u.top_connectors.length > 0 && (
                    <div>
                      <p className="m-0 mb-1 text-[12px] text-[#666666]">Connectors</p>
                      <div className="flex flex-wrap gap-1">
                        {u.top_connectors.map(c => <Tag key={c}>{c}</Tag>)}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <span className="text-[12px] text-[#8F8F8F] tabular-nums">
                {u.skill_count} skill · {u.connector_count} connector
              </span>
            </span>
            <span className="font-medium tabular-nums shrink-0">{u.total_count.toLocaleString()}</span>
          </div>
        );
      })}

      {/* The current user's position when outside the top five */}
      {userRank && userRank.rank > 5 && (
        <div className="flex items-center gap-2.5 px-4 py-2 border-t border-dashed border-[#DADADA] bg-[#F5F8FF]">
          <span className="w-6 shrink-0 font-medium text-[#245BF3] tabular-nums">#{userRank.rank}</span>
          <span className="w-6 h-6 rounded-full bg-white border border-[#245BF3] text-[11px] font-semibold text-[#245BF3] inline-flex items-center justify-center shrink-0">
            me
          </span>
          <span className="flex-1 font-medium text-[#245BF3]">You</span>
          <span className="font-medium tabular-nums text-[#245BF3] shrink-0">{userRank.total_count.toLocaleString()}</span>
        </div>
      )}
    </Panel>
  );
}

// ── Skills to try ─────────────────────────────────────────────────────────────

function SkillsToTry({ skills }: { skills: SkillToTry[] }) {
  const [openId, setOpenId] = useState<number | null>(null);

  if (!skills.length) return (
    <Panel title="Skills to try">
      <Muted>You&apos;ve tried everything your organisation uses.</Muted>
    </Panel>
  );

  // Build a LibraryEntry-compatible stub for InstallPanel
  function toEntry(s: SkillToTry): LibraryEntry {
    return { id: s.id, name: s.name, type: s.type as 'skill' | 'connector', surface: 'cowork', source: 'org', description: s.description, install_guide: s.install_guide, source_url: null, author_name: null, is_published: 1, invocation_count: s.invocation_count, user_count: s.user_count, vote_count: 0, user_voted: 0, week_count: 0, trend_pct: 0 };
  }

  return (
    <section className="bg-white border border-[#EAEAEA] rounded-[14px] min-w-0" onClick={() => setOpenId(null)}>
      <div className="flex items-center gap-x-3 gap-y-1 flex-wrap px-4 py-3 border-b border-[#EAEAEA]">
        <h2 className="m-0 text-[14px] font-semibold text-[#0A0A0A] leading-5">Skills to try</h2>
        <span className="text-[13px] text-[#8F8F8F]">Your teammates use these; you haven&apos;t yet</span>
      </div>
      {skills.map(s => (
        <div
          key={s.id}
          className="flex items-center gap-2.5 px-4 py-2.5 border-t border-[#F2F2F2] first:border-t-0"
          onClick={ev => ev.stopPropagation()}
        >
          <Link href={`/library/${s.id}`} className="group min-w-0 flex-1 flex flex-col">
            <span className="font-mono text-[13px] font-medium text-[#0A0A0A] group-hover:underline truncate">{fmt(s.name)}</span>
            {s.description && <span className="text-[13px] text-[#8F8F8F] truncate">{s.description}</span>}
          </Link>
          <span className="text-[13px] text-[#8F8F8F] tabular-nums shrink-0">{s.user_count} {s.user_count === 1 ? 'user' : 'users'}</span>
          <div className="relative shrink-0">
            <InstallButton
              eligible={!!s.install_guide}
              open={openId === s.id}
              onToggle={() => setOpenId(openId === s.id ? null : s.id)}
            />
            {openId === s.id && (
              <InstallPanel entry={toEntry(s)} align="right" onClose={() => setOpenId(null)} />
            )}
          </div>
        </div>
      ))}
    </section>
  );
}

// ── Department breakdown ─────────────────────────────────────────────────────

function DeptBreakdown({ rows }: { rows: DeptRow[] }) {
  if (!rows.length) return null;
  const max = rows[0]?.total_uses ?? 1;

  return (
    <Panel title="By department" subtitle="Skill and connector usage across your organisation" flush>
      {rows.map(r => {
        const skillPct  = r.total_uses > 0 ? Math.round((r.skill_uses / r.total_uses) * 100) : 0;
        const barPct    = Math.round((r.total_uses / max) * 100);
        return (
          <div key={r.department} className="px-4 py-2.5 border-t border-[#F2F2F2] first:border-t-0 flex flex-col gap-1.5">
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="text-[14px] font-medium text-[#0A0A0A] truncate">{r.department}</span>
              <span className="text-[13px] text-[#8F8F8F] tabular-nums truncate">
                {r.skill_uses} skills · {r.connector_uses} connectors · {r.user_count} {r.user_count === 1 ? 'person' : 'people'}
              </span>
              <span className="ml-auto text-[13px] font-medium text-[#0A0A0A] tabular-nums shrink-0">{r.total_uses.toLocaleString()}</span>
            </div>
            {/* Split bar: blue = skills, grey = connectors, scaled to the busiest department */}
            <div className="w-full h-1.5 rounded-full bg-[#F2F2F2] overflow-hidden">
              <div className="h-full flex gap-px" style={{ width: `${barPct}%` }}>
                <div className="h-full bg-[#05073F]" style={{ width: `${skillPct}%` }} />
                <div className="h-full bg-[#B3B3B3] flex-1" />
              </div>
            </div>
          </div>
        );
      })}
      <PanelFoot>
        <span className="inline-flex items-center gap-4">
          <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#05073F]" aria-hidden="true" />Skills</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[#B3B3B3]" aria-hidden="true" />Connectors</span>
        </span>
      </PanelFoot>
    </Panel>
  );
}

// ── Unclaimed banner ──────────────────────────────────────────────────────────

function UnclaimedBanner({ count, onDismiss, onClaim }: { count: number; onDismiss: () => void; onClaim: () => void }) {
  if (count === 0) return null;
  return (
    <Notice
      tone="warn"
      title={
        <>
          <LineIcon d={ICON.flag} className="inline-block align-[-2px] mr-1.5" />
          {`${count} skill${count !== 1 ? 's' : ''} ${count !== 1 ? 'have' : 'has'} no owner.`}
        </>
      }
      action={
        <span className="flex items-center gap-3">
          <button
            type="button"
            className="text-[14px] font-medium text-[#8A5300] hover:underline"
            onClick={() => { onClaim(); onDismiss(); }}
          >
            Claim one
          </button>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="text-[#B08A4A] hover:text-[#5C3A00]"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </span>
      }
    >
      These are in use across your organisation but nobody has claimed them yet. Be the first: add a description and own it.
    </Notice>
  );
}

// ── Install guide popover ────────────────────────────────────────────────────

function InstallPanel({ entry, onClose, align = 'left' }: { entry: LibraryEntry; onClose: () => void; align?: 'left' | 'right' }) {
  const [copied, setCopied] = useState(false);
  const eligible = entry.is_published === 1 && !!entry.install_guide;

  const copyGuide = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await navigator.clipboard.writeText(entry.install_guide ?? '').catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={cx('absolute top-full mt-1.5 w-64 bg-white border border-[#EAEAEA] rounded-[14px] shadow-[0_4px_16px_rgba(0,0,0,0.08)] p-3 z-50 text-left whitespace-normal',
        align === 'right' ? 'right-0' : 'left-0')}
      onClick={e => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-2">
        <p className="m-0 text-[13px] font-medium text-[#0A0A0A]">Install guide</p>
        <button type="button" onClick={onClose} aria-label="Close install guide" className="text-[#8F8F8F] hover:text-[#0A0A0A]">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      {eligible ? (
        <div className="flex items-start gap-1.5 bg-[#FAFAFA] border border-[#EAEAEA] rounded-[10px] px-2 py-1.5">
          <p className="m-0 text-[13px] text-[#0A0A0A] whitespace-pre-wrap flex-1">{entry.install_guide}</p>
          <button
            type="button"
            onClick={copyGuide}
            aria-label={copied ? 'Copied' : 'Copy install guide'}
            className={cx('shrink-0', copied ? 'text-[#1A7F37]' : 'text-[#8F8F8F] hover:text-[#0A0A0A]')}
          >
            {copied
              ? <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
              : <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.637c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" /></svg>
            }
          </button>
        </div>
      ) : (
        <p className="m-0 text-[13px] text-[#8F8F8F]">
          {entry.is_published === 1 ? 'No install guide yet. Edit this entry to add one.' : 'Claim this entry and add an install guide before it can be installed.'}
        </p>
      )}
    </div>
  );
}

// ── Anthropic catalogue ──────────────────────────────────────────────────────

function AnthropicCatalog({ entries, onVote }: { entries: LibraryEntry[]; onVote: (id: number) => void }) {
  const [openId, setOpenId] = useState<number | null>(null);
  if (!entries.length) return null;
  return (
    <section className="bg-white border border-[#EAEAEA] rounded-[14px] min-w-0" onClick={() => setOpenId(null)}>
      <div className="flex items-center gap-x-3 gap-y-1 flex-wrap px-4 py-3 border-b border-[#EAEAEA]">
        <h2 className="m-0 text-[14px] font-semibold text-[#0A0A0A] leading-5">Explore from Anthropic</h2>
        <span className="text-[13px] text-[#8F8F8F]">Official skills you can install to extend what Claude can do across your organisation</span>
        <span className="ml-auto text-[13px] text-[#666666] tabular-nums">{entries.length} available</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 p-4">
        {entries.map(e => (
          <div
            key={e.id}
            className="flex flex-col gap-2 px-3.5 py-3 border border-[#EAEAEA] rounded-[14px] min-w-0"
            onClick={ev => ev.stopPropagation()}
          >
            <span className="flex items-center gap-2 min-w-0">
              <Link href={`/library/${e.id}`} className="font-mono text-[13px] font-semibold text-[#0A0A0A] hover:underline truncate">{fmt(e.name)}</Link>
              <Tag>Anthropic</Tag>
            </span>
            <span className="text-[14px] leading-5 text-[#4D4D4D] line-clamp-2">{e.description ?? 'No description yet.'}</span>
            <span className="flex items-center gap-1.5 mt-auto">
              <span className="relative">
                <InstallButton
                  eligible={e.is_published === 1 && !!e.install_guide}
                  open={openId === e.id}
                  onToggle={() => setOpenId(openId === e.id ? null : e.id)}
                />
                {openId === e.id && <InstallPanel entry={e} onClose={() => setOpenId(null)} />}
              </span>
              <VoteButton voted={!!e.user_voted} count={e.vote_count} onClick={() => onVote(e.id)} />
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Filtered results ─────────────────────────────────────────────────────────

function FilteredList({ entries, onVote }: { entries: LibraryEntry[]; onVote: (id: number) => void }) {
  return (
    <Panel title="Results" subtitle={<span className="tabular-nums">{entries.length}</span>} flush>
      {entries.length === 0 ? (
        <div className="p-4"><Muted>No results found.</Muted></div>
      ) : (
        entries.map(e => {
          const isUnclaimed = e.is_published === 0;
          const rw = e.type === 'connector' ? readWriteLine(e) : null;
          return (
            <div key={e.id} className="flex items-start gap-3 px-4 py-2.5 border-t border-[#F2F2F2] first:border-t-0 hover:bg-[#FAFAFA]">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0 flex-wrap">
                  <Link href={`/library/${e.id}`} className="font-mono text-[13px] font-medium text-[#0A0A0A] hover:underline truncate">{fmt(e.name)}</Link>
                  <Tag>{e.type}</Tag>
                  {e.source === 'anthropic' && <Tag>Anthropic</Tag>}
                  {isUnclaimed && <Tag tone="warn">Unclaimed</Tag>}
                </div>
                {e.description && <p className="m-0 mt-0.5 text-[#666666] truncate">{e.description}</p>}
                {rw && <p className="m-0 mt-0.5 text-[13px] text-[#8F8F8F] tabular-nums truncate">{rw}</p>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[13px] text-[#666666] tabular-nums whitespace-nowrap">
                  {e.invocation_count}× · {e.user_count} {e.user_count === 1 ? 'user' : 'users'}
                </span>
                {isUnclaimed ? (
                  <Link
                    href={`/library/submit?name=${encodeURIComponent(e.name)}&type=${e.type}`}
                    className={cx(SMALL_BTN, '!border-[#F5D9A8] !text-[#8A5300] !bg-[#FFFAF0]')}
                  >
                    Claim
                  </Link>
                ) : (
                  <VoteButton voted={!!e.user_voted} count={e.vote_count} onClick={() => onVote(e.id)} />
                )}
              </div>
            </div>
          );
        })
      )}
    </Panel>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

const FILTERS = [
  { label: 'All',        type: '',          claimed: '',      source: '' },
  { label: 'Skills',     type: 'skill',     claimed: '',      source: '' },
  { label: 'Connectors', type: 'connector', claimed: '',      source: '' },
  { label: 'Anthropic',  type: '',          claimed: '',      source: 'anthropic' },
  { label: 'Unclaimed',  type: '',          claimed: 'false', source: '' },
];

export default function LibraryPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [data, setData] = useState<LibraryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [typeFilter, setTypeFilter] = useState('');
  const [claimedFilter, setClaimedFilter] = useState(() => searchParams.get('claimed') ?? '');
  const [sourceFilter, setSourceFilter] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [sort, setSort] = useState('most_used');
  const [q, setQ] = useState('');
  const [searchInput, setSearchInput] = useState('');

  const fetchData = useCallback(async () => {
    setLoading(true);
    const p = new URLSearchParams({ per_page: '200' });
    if (typeFilter)    p.set('type', typeFilter);
    if (claimedFilter) p.set('claimed', claimedFilter);
    if (sourceFilter)  p.set('source', sourceFilter);
    if (deptFilter)    p.set('department', deptFilter);
    if (sort)          p.set('sort', sort);
    if (q)             p.set('q', q);
    try {
      const res = await fetch(`/api/library?${p}`);
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [typeFilter, claimedFilter, sourceFilter, deptFilter, sort, q]);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Handle ?claimed=false from banner link
  useEffect(() => {
    if (claimedFilter === 'false') setBannerDismissed(true);
  }, [claimedFilter]);

  const handleVote = async (id: number) => {
    setData(prev => {
      if (!prev) return prev;
      const entry = prev.entries.find(e => e.id === id);
      if (!entry) return prev;
      const nowVoted = !entry.user_voted;
      return {
        ...prev,
        entries: prev.entries.map(e => e.id === id
          ? { ...e, user_voted: nowVoted ? 1 : 0, vote_count: e.vote_count + (nowVoted ? 1 : -1) }
          : e),
      };
    });
    const res = await fetch(`/api/library/${id}/vote`, { method: 'POST' });
    if (res.ok) {
      const { voted, count } = await res.json() as { voted: boolean; count: number };
      setData(prev => prev ? {
        ...prev,
        entries: prev.entries.map(e => e.id === id ? { ...e, user_voted: voted ? 1 : 0, vote_count: count } : e),
      } : prev);
    } else {
      fetchData();
    }
  };

  const isFiltered = !!(typeFilter || claimedFilter || sourceFilter || deptFilter || q);
  const allOrg           = data?.entries.filter(e => e.source === 'org') ?? [];
  const anthropicEntries = data?.entries.filter(e => e.source === 'anthropic') ?? [];
  const allOrgSkills          = allOrg.filter(e => e.type === 'skill');
  const allOrgConnectors      = allOrg.filter(e => e.type === 'connector');
  const anthropicConnectors   = anthropicEntries.filter(e => e.type === 'connector');
  const topSkills             = allOrgSkills;
  const topConnectors         = [...allOrgConnectors, ...anthropicConnectors];

  if (loading && !data) return (
    <>
      <TopBar title="Skills and Connectors Board" subtitle="Discover, claim, and compete: your org's AI capability in one place" />
      <LoadingSpinner />
    </>
  );

  return (
    <>
      <TopBar title="Skills and Connectors Board" subtitle="Discover, claim, and compete: your org's AI capability in one place" />

      <PageBody>
        <Toolbar>
          <button type="button" className={B.primary} onClick={() => router.push('/library/submit')}>
            <LineIcon d={ICON.plus} />
            Submit a skill
          </button>
        </Toolbar>

        {/* Headline figures */}
        {data && <HeadlineStrip data={data} />}

        {/* Unclaimed banner */}
        {!bannerDismissed && data && data.unclaimed_count > 0 && (
          <UnclaimedBanner
            count={data.unclaimed_count}
            onDismiss={() => setBannerDismissed(true)}
            onClaim={() => { setTypeFilter(''); setClaimedFilter('false'); setSourceFilter(''); }}
          />
        )}

        {/* Search + filters */}
        <div className="flex gap-2 items-center flex-wrap">
          <label className="flex-1 min-w-[220px] flex items-center gap-2 px-2.5 py-1.5 border border-[#DADADA] rounded-[10px] bg-white text-[#8F8F8F] focus-within:ring-2 focus-within:ring-[#245BF3]/30 focus-within:border-[#245BF3]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="search"
              placeholder="Search skills and connectors"
              aria-label="Search skills and connectors"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[14px] text-[#0A0A0A] placeholder:text-[#8F8F8F]"
            />
          </label>
          {FILTERS.map(f => (
            <Chip
              key={f.label}
              on={typeFilter === f.type && claimedFilter === f.claimed && sourceFilter === f.source}
              onClick={() => { setTypeFilter(f.type); setClaimedFilter(f.claimed); setSourceFilter(f.source); }}
            >
              {f.label}
              {f.claimed === 'false' && data?.unclaimed_count ? (
                <span className="ml-1.5 tabular-nums text-[#8A5300]">{data.unclaimed_count}</span>
              ) : null}
            </Chip>
          ))}
          <select
            aria-label="Department"
            value={deptFilter}
            onChange={e => setDeptFilter(e.target.value)}
            className={B.select}
          >
            <option value="">All departments</option>
            <option value="mine">My department</option>
          </select>
          <select
            aria-label="Sort"
            value={sort}
            onChange={e => setSort(e.target.value)}
            className={B.select}
          >
            <option value="most_used">Most used</option>
            <option value="trending">Trending</option>
            <option value="most_voted">Most voted</option>
            <option value="newest">Newest</option>
          </select>
        </div>

        {loading && <div className="py-6 text-center"><Muted>Loading…</Muted></div>}

        {/* Filtered view */}
        {!loading && isFiltered && data && (
          <FilteredList entries={data.entries} onVote={handleVote} />
        )}

        {/* Default view */}
        {!loading && !isFiltered && data && (
          <>
            <Highlights entries={data.entries} recentEntries={data.recent_entries} deptPicks={data.dept_picks} userDept={data.user_dept} />

            {/* Left: the list and departments. Right: leaderboard and skills to try. */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="lg:col-span-2 flex flex-col gap-4 min-w-0">
                <TabbedTopList
                  skills={topSkills}
                  connectors={topConnectors}
                  skillTotal={allOrgSkills.length}
                  connectorTotal={topConnectors.length}
                  onVote={handleVote}
                />
                <DeptBreakdown rows={data.dept_breakdown} />
              </div>
              <div className="flex flex-col gap-4 min-w-0">
                <LeaderboardSidebar users={data.leaderboard} userRank={data.user_rank} />
                <SkillsToTry skills={data.skills_to_try} />
              </div>
            </div>

            {/* Anthropic catalogue: skills only; connectors appear in the list above */}
            <AnthropicCatalog entries={anthropicEntries.filter(e => e.type === 'skill')} onVote={handleVote} />
          </>
        )}
      </PageBody>
    </>
  );
}
